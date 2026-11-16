/** 找东西：独立初始化登录与历史，通过任务快照及时展示文字和卡片。 */
const { request, ApiError } = require("../../services/api");
const { ensureLogin } = require("../../services/auth");
const { transcribeAudio } = require("../../services/upload");
const { pollTask } = require("../../services/tasks");
const { PageScope } = require("../../services/page-scope");
const { store } = require("../../store/index");
const { bindNotice, registerNotice, showNotice, confirmNotice } = require("../../services/notice");

Page({
  data: {
    notice: null,
    sessionReady: false,
    noFamily: false,
    syncingHistory: false,
    loadingHistory: false,
    processing: false,
    transcribing: false,
    clearing: false,
    messages: [],
    draft: null,
    textQuery: "",
    pendingText: "",
    nextBefore: null,
    errorText: "",
    scrollTarget: "",
  },
  _guard: null,
  _scope: null,
  _followBottom: true,
  _lastScrollTop: 0,
  _historyLoaded: false,

  /** 建立页面请求生命周期。 */
  onLoad() {
    this._guard = new PageScope();
  },
  /** 返回同一家庭时保留已显示内容，在后台同步历史和活动任务。 */
  onShow() {
    registerNotice(bindNotice(this));
    this._guard.show();
    this.activate();
  },
  /** 结束本地等待，服务器继续生成回复；录音由输入栏在页面隐藏时自行中断。 */
  onHide() {
    registerNotice(null);
    this._guard.hide();
    this.setData({ sessionReady: false, syncingHistory: false, loadingHistory: false, transcribing: false });
  },
  /** 回收页面上的请求与录音。 */
  onUnload() {
    this.onHide();
  },
  /** 历史和活动任务同步完成后开放操作，保留同一家庭已显示的消息。 */
  async activate() {
    if (this.data.syncingHistory) return;
    const guard = this._guard;
    const frame = guard.frame();
    this.setData({ sessionReady: false, syncingHistory: true, errorText: "" });
    try {
      await ensureLogin();
      if (!guard.isFrameCurrent(frame)) return;
      if (!this._scope || !store.isCurrentScope(this._scope)) {
        this.resetConversation();
      }
      this._scope = store.captureScope();
      this.setData({ noFamily: !this._scope.familyId });
      if (!this._scope.familyId) return;
      const op = guard.capture();
      const result = await guard.run(op, (hooks) => request({
        path: `/chat/history?family_id=${this._scope.familyId}`, ...hooks,
      }));
      if (!guard.isCurrent(op)) return;
      const patch = this.messagePatch(result.messages);
      // 已加载更早历史时保留原游标，不把它重置到最新30条之前。
      if (!this._historyLoaded) patch.nextBefore = result.next_before;
      this._historyLoaded = true;
      const active = result.active_task;
      this.setData({
        ...patch,
        sessionReady: true,
        processing: !!active && !active.done,
        pendingText: "", draft: null,
      });
      if (active) this.waitForReply(active.task_id, op, active);
      this.scrollBottom();
    } catch (error) {
      if (!guard.isFrameCurrent(frame)) return;
      if (error instanceof ApiError && error.code === "LOGIN_BLOCKED") {
        wx.reLaunch({ url: "/pages/launch/index" });
        return;
      }
      this.setData({ errorText: error.message });
    } finally {
      if (guard.isFrameCurrent(frame)) this.setData({ syncingHistory: false });
    }
  },
  /** 用户或家庭切换时清除该页面的会话状态。 */
  resetConversation() {
    this._scope = null;
    this._followBottom = true;
    this._lastScrollTop = 0;
    this._historyLoaded = false;
    this.setData({
      sessionReady: false, messages: [], draft: null, textQuery: "", pendingText: "",
      nextBefore: null, processing: false,
    });
  },
  /** 完整消息以原始编号去重，仅在新增消息时更新列表；草稿使用独立字段。 */
  messagePatch(incoming) {
    const previous = this.data.messages;
    const messages = new Map(previous.map((message) => [message.id, message]));
    incoming.forEach((message) => messages.set(message.id, message));
    if (messages.size === previous.length) return {};
    return { messages: [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
  },
  /** 加载更早历史时保留原首条消息位置，后续生成不强制拉回底部。 */
  async loadHistory() {
    if (this.data.clearing || !this.data.sessionReady || this.data.syncingHistory ||
        this.data.loadingHistory || !this.data.nextBefore) return;
    const guard = this._guard;
    const op = guard.capture();
    const anchor = this.data.messages[0].id;
    this._followBottom = false;
    this.setData({ loadingHistory: true });
    try {
      const result = await guard.run(op, (hooks) => request({
        path: `/chat/history?family_id=${this._scope.familyId}&before=${encodeURIComponent(this.data.nextBefore)}`,
        ...hooks,
      }));
      if (!guard.isCurrent(op)) return;
      this.setData({
        ...this.messagePatch(result.messages), nextBefore: result.next_before,
        scrollTarget: `message-${anchor}`,
      });
    } catch (error) {
      if (guard.isCurrent(op)) showNotice(error.message);
    } finally {
      if (guard.isCurrent(op)) this.setData({ loadingHistory: false });
    }
  },
  /** 用户向上滚动后停止自动跟随新消息。 */
  onListScroll(e) {
    if (e.detail.scrollTop < this._lastScrollTop - 2) this._followBottom = false;
    this._lastScrollTop = e.detail.scrollTop;
  },
  /** 用户滚回底部后恢复跟随。 */
  onListBottom() {
    this._followBottom = true;
  },
  /** 仅在跟随模式或用户主动发送时滚动到底部。 */
  scrollBottom(force = false) {
    if (force) this._followBottom = true;
    if (!this._followBottom) return;
    this.setData({ scrollTarget: "" }, () => this.setData({ scrollTarget: "chat-bottom" }));
  },
  /** 保存草稿，历史加载和回复生成期间也可编辑。 */
  onTextInput(e) {
    this.setData({ textQuery: e.detail.value });
  },
  /** 文字通过统一发送入口提交。 */
  onTextSubmit() {
    this.sendMessage(this.data.textQuery);
  },
  /** 语音先转写，再进入统一消息接口；可录音状态由输入栏的禁用属性控制。 */
  async onRecordFinish(e) {
    const guard = this._guard;
    const op = guard.capture();
    this.setData({ transcribing: true });
    try {
      const result = await guard.run(op, (hooks) => transcribeAudio(e.detail.tempFilePath, hooks));
      if (!guard.isCurrent(op)) return;
      this.setData({ transcribing: false });
      this.sendMessage(result.transcript);
    } catch (error) {
      if (guard.isCurrent(op)) showNotice(error.message);
    } finally {
      if (guard.isCurrent(op)) this.setData({ transcribing: false });
    }
  },
  /** 麦克风权限失败时切换到文字输入。 */
  onPermissionDenied() {
    this.selectComponent("#composer").useTextInput();
    showNotice("麦克风不可用");
  },
  /** 展示录音错误。 */
  onRecordError(e) {
    showNotice(e.detail.message);
  },
  /** 可发送状态由输入栏的禁用属性统一控制，提交时立即锁定。 */
  async sendMessage(input) {
    const text = input.trim();
    if (!text || text.length > 2000) {
      showNotice(text ? "输入不能超过2000字" : "请输入内容");
      return;
    }
    const guard = this._guard;
    const op = guard.capture();
    this.setData({ processing: true, pendingText: text, textQuery: "", draft: null, errorText: "" });
    this.scrollBottom(true);
    try {
      const result = await guard.run(op, (hooks) => request({
        path: "/chat/messages", method: "POST",
        data: { family_id: this._scope.familyId, text }, ...hooks,
      }));
      if (!guard.isCurrent(op)) return;
      this.waitForReply(result.task_id, op);
    } catch (error) {
      if (!guard.isCurrent(op)) return;
      this.setData({ processing: false, pendingText: "", textQuery: this.data.textQuery || text });
      showNotice(error.message);
    }
  },
  /** 交付新消息和文字草稿，原始编号保证历史恢复时不重复显示。 */
  applyProgress(progress) {
    const patch = { ...this.messagePatch(progress.messages), draft: progress.draft };
    if (progress.messages.some((message) => message.role === "user")) patch.pendingText = "";
    this.setData(patch);
    this.scrollBottom();
  },
  /** 轮询任务，先展示进度再处理完成或失败。 */
  async waitForReply(taskId, op, initialStatus) {
    const guard = this._guard;
    try {
      const result = await guard.run(op, (hooks) => pollTask(taskId, {
        ...hooks, timeoutMs: Infinity, initialStatus,
        onProgress: (progress) => {
          if (guard.isCurrent(op)) this.applyProgress(progress);
        },
      }));
      if (!guard.isCurrent(op)) return;
      this.setData({
        ...this.messagePatch(result.messages),
        processing: false, pendingText: "", draft: null,
      });
      this.scrollBottom();
    } catch (error) {
      if (!guard.isCurrent(op)) return;
      // 查询失败不代表后台任务结束，由用户主动重试同步状态后再开放发送。
      this.setData({
        sessionReady: false, processing: false, errorText: error.message,
      });
    }
  },
  /** 确认后清空当前对话，成功后同步移除页面消息与历史游标。 */
  async clearHistory() {
    if (!this.data.sessionReady || this.data.noFamily || this.data.processing ||
        this.data.transcribing || this.data.clearing || this.data.syncingHistory ||
        this.data.loadingHistory) return;
    const guard = this._guard;
    const op = guard.capture();
    this.setData({ clearing: true });
    this.selectComponent("#composer").interrupt();
    try {
      const confirmed = await confirmNotice({
        title: "清空对话",
        text: "将删除当前家庭中你的全部聊天记录和 AI 上下文，清空后无法恢复。确定清空吗？",
        confirmText: "清空",
        cancelText: "取消",
      });
      if (!confirmed || !guard.isCurrent(op)) return;
      await guard.run(op, (hooks) => request({
        path: `/chat/history?family_id=${op.scope.familyId}`, method: "DELETE", ...hooks,
      }));
      if (!guard.isCurrent(op)) return;
      this._historyLoaded = true;
      this._followBottom = true;
      this._lastScrollTop = 0;
      this.setData({
        messages: [], draft: null, pendingText: "", nextBefore: null,
        errorText: "", scrollTarget: "",
      });
    } catch (error) {
      if (guard.isCurrent(op)) showNotice(error.message);
    } finally {
      this.setData({ clearing: false });
    }
  },
  /** 显式重试页面初始化。 */
  onRetry() {
    this.activate();
  },
  /** 打开现有物品详情页。 */
  onItemTap(e) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${e.detail.item.id}` });
  },
  /** 无家庭时返回首页。 */
  goHome() {
    wx.switchTab({ url: "/pages/home/index" });
  },
});
