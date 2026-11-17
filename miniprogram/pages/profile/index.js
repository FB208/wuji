/** P08 个人中心：账号、家庭、数据、关于（文档 8.5）。 */
const { request, ApiError, clearToken } = require("../../services/api");
const { blockAutoLogin, ensureLogin, refreshMe } = require("../../services/auth");
const { PageScope } = require("../../services/page-scope");
const { store } = require("../../store/index");
const { bindNotice, registerNotice, showNotice, confirmNotice, promptNotice } = require("../../services/notice");

Page({
  data: {
    notice: null,
    nickname: "",
    avatarUrl: "",
    userCode: "",
    familyName: "",
    familyCount: 0,
    itemCount: null,
    version: "V1.0",
    ready: false,
    busy: false,
    noFamily: false,
    errorText: "",
  },
  _guard: null,
  _sessionScope: null,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    registerNotice(bindNotice(this));
    const guard = this._guard;
    guard.show();
    this.activate();
  },
  async activate() {
    const guard = this._guard;
    const oldSession = this._sessionScope;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    this.setData({
      busy: true, ready: false, nickname: "", avatarUrl: "", userCode: "",
      familyName: "", familyCount: 0, itemCount: null, errorText: "",
    });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({ busy: false, ready: false, errorText: "登录失败，请重试" });
      if (err instanceof ApiError && err.code === "LOGIN_BLOCKED") {
        wx.reLaunch({ url: "/pages/launch/index" });
      }
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    if (!scope.userId) {
      this._sessionScope = null;
      this.setData({ busy: false, ready: false });
      return;
    }
    this._sessionScope = scope;
    const scopeChanged =
      !oldSession ||
      oldSession.userId !== scope.userId ||
      oldSession.familyId !== scope.familyId ||
      oldSession.version !== scope.version;
    if (scopeChanged) {
      this.setData({ familyName: "", familyCount: 0, itemCount: 0, errorText: "" });
    }
    const family = store.currentFamily();
    this.setData({
      busy: false,
      ready: true,
      noFamily: !scope.familyId,
      nickname: store.user ? store.user.nickname || "微信用户" : "",
      avatarUrl: store.user ? store.user.avatar_url || "" : "",
      userCode: store.user ? store.user.user_code || "" : "",
      familyName: family ? family.name : "选择家庭",
      familyCount: store.families.length,
      itemCount: scope.familyId ? null : 0,
    });
    if (!scope.familyId) return;
    await this.loadItemCount(scope);
  },
  onHide() {
    registerNotice(null);
    this._guard.hide();
  },
  onUnload() {
    this.onHide();
  },

  active() {
    const guard = this._guard;
    return (
      !!guard &&
      guard.isFrameCurrent(guard.frame()) &&
      this.data.ready &&
      !this.data.busy &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },

  clearChangedScope(op) {
    const guard = this._guard;
    if (!guard.scopeChanged(op)) return false;
    guard.invalidate();
    this._sessionScope = null;
    this.setData({
      nickname: "", avatarUrl: "", userCode: "", familyName: "", familyCount: 0, itemCount: null,
      ready: false, busy: false, noFamily: false, errorText: "登录或家庭已变化，请重试",
    });
    return true;
  },
  async loadItemCount(scope) {
    const guard = this._guard;
    const op = guard.capture();
    if (!guard.isCurrent(op) || !store.isCurrentScope(scope) || !scope.familyId) return;
    try {
      const data = await guard.run(op, (hooks) =>
        request({
          path: `/items?family_id=${op.scope.familyId}&page=1&page_size=1`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (this.clearChangedScope(op)) return;
      if (!guard.isCurrent(op)) return;
      this.setData({ itemCount: data.total });
    } catch (err) {
      if (this.clearChangedScope(op)) return;
      if (!guard.isCurrent(op)) return;
      if (err instanceof ApiError && err.statusCode === 403) {
        try {
          await refreshMe();
        } catch (_) {}
        if (this.clearChangedScope(op)) return;
        if (!guard.isCurrent(op)) return;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ errorText: message });
    }
  },

  onRetry() {
    const guard = this._guard;
    if (!guard.isFrameCurrent(guard.frame())) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      if (!this.data.busy) this.activate();
      return;
    }
    if (!this.active()) return;
    this.activate();
  },
  goFamily() {
    if (!this.active()) return;
    if (!this._sessionScope.familyId) {
      wx.navigateTo({ url: "/pages/family-list/index" });
      return;
    }
    wx.navigateTo({ url: "/pages/family/index" });
  },
  onSwitchFamily() {
    if (!this.active()) return;
    wx.navigateTo({ url: "/pages/family-list/index" });
  },
  async onCreateFamily() {
    if (!this.active()) return;
    const op = this._guard.capture();
    const uid = this._sessionScope.userId;
    const name = ((await promptNotice({ title: "创建家庭组", placeholderText: "家庭组名称", confirmText: "创建" })) || "").trim();
    const guard = this._guard;
    if (!name || name.length > 64) return;
    if (!guard.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
    let finishOp = op;
    this.setData({ busy: true });
    try {
      const family = await guard.run(op, (hooks) =>
        request({
          path: "/families",
          method: "POST",
          data: { name },
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (this.clearChangedScope(op) || !guard.isCurrent(op)) return;
      await refreshMe(false, family.id);
      if (!guard.isFrameCurrent(op.generation)) return;
      if (!store.user || store.user.id !== uid) {
        this.clearChangedScope(op);
        return;
      }
      const newScope = store.captureScope();
      finishOp = guard.capture();
      this._sessionScope = newScope;
      const cur = store.currentFamily();
      this.setData({
        ready: true,
        nickname: store.user.nickname || "微信用户",
        avatarUrl: store.user.avatar_url || "",
        userCode: store.user.user_code || "",
        familyName: cur ? cur.name : "选择家庭",
        familyCount: store.families.length,
        noFamily: !newScope.familyId,
        itemCount: newScope.familyId ? null : 0,
      });
      if (newScope.familyId) await this.loadItemCount(newScope);
      if (!guard.isCurrent(finishOp) || !store.user || store.user.id !== uid) return;
      showNotice("已创建");
    } catch (err) {
      if (this.clearChangedScope(finishOp) || !guard.isCurrent(finishOp)) return;
      const message = err instanceof ApiError ? err.message : "创建失败，请重试";
      showNotice(message);
    } finally {
      if (guard.isCurrent(finishOp)) this.setData({ busy: false });
    }
  },
  onCopyUserCode() {
    const code = this.data.userCode;
    if (!code) return;
    wx.setClipboardData({ data: code });
  },
  onHowToJoin() {
    if (!this.active()) return;
    showNotice({
      title: "如何加入家庭",
      text: "点击上方的用户ID复制，发给家庭组所有者；对方在「成员管理」里点「添加家庭成员」并填写你的ID，即可把你加入家庭组。",
    });
  },
  onPrivacy() {
    if (!this.active()) return;
    showNotice({
      title: "隐私说明",
      text: "照片仅用于保存和展示物品外观；语音仅用于转写为文字后记录和查找物品，转写完成后语音文件即被删除；家庭组成员可以访问该家庭组内全部物品记录。",
    });
  },
  onFeedback() {
    if (!this.active()) return;
    showNotice("可通过小程序客服反馈问题");
  },
  async onPurgeDeleted() {
    if (!this.active() || !this._sessionScope.familyId) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const ok = await confirmNotice({ title: "清理已删除记录", text: "将永久删除当前家庭组的已删除物品及其照片，无法恢复。", confirmText: "清理" });
    const g = this._guard;
    if (!ok || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
    this.setData({ busy: true });
    try {
      const data = await g.run(op, (hooks) =>
        request({
          path: `/families/${fid}/purge-deleted`,
          method: "POST",
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (this.clearChangedScope(op) || !g.isCurrent(op)) return;
      showNotice(data.purged > 0 ? `已清理 ${data.purged} 条` : "没有已删除记录");
    } catch (err) {
      if (this.clearChangedScope(op) || !g.isCurrent(op)) return;
      const message = err instanceof ApiError ? err.message : "清理失败，请重试";
      showNotice(message);
    } finally {
      if (g.isCurrent(op)) this.setData({ busy: false });
    }
  },
  async onDeleteAccount() {
    if (!this.active()) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const input = await promptNotice({ title: "注销账号", text: "注销后账号与全部数据将被删除，无法恢复。", placeholderText: "请输入「注销」确认", confirmText: "注销" });
    const g = this._guard;
    if (input === null || (input || "").trim() !== "注销" || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
    this.setData({ busy: true });
    try {
      await g.run(op, (hooks) =>
        request({ path: "/me", method: "DELETE", isCancelled: hooks.isCancelled, onTask: hooks.onTask })
      );
      blockAutoLogin();
      clearToken();
      store.clearSession();
      wx.reLaunch({ url: "/pages/launch/index" });
    } catch (err) {
      if (this.clearChangedScope(op) || !g.isCurrent(op)) return;
      const message = err instanceof ApiError ? err.message : "注销失败，请重试";
      this.setData({ busy: false });
      showNotice(message);
    }
  },
});
