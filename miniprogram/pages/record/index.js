/** 收起来：本轮问答、直接保存及保存后修改。 */
const { newIdempotencyKey, ApiError } = require("../../services/api");
const { ensureLogin } = require("../../services/auth");
const { uploadImage, transcribeAudio, recordItem } = require("../../services/upload");
const { PageScope } = require("../../services/page-scope");
const { bindNotice, registerNotice, showNotice } = require("../../services/notice");
const { store } = require("../../store/index");

const STAGE_TEXT = {
  queued: "排队中",
  asr_start: "开始转写",
  asr_submit: "提交语音",
  asr_submitted: "已提交",
  asr_polling: "处理中",
  judging: "整理内容",
  writing: "保存结果",
  done: "处理完成",
  failed: "处理失败",
};

Page({
  data: {
    state: "INPUT",
    photoPath: "",
    cameraOpen: false,
    cameraError: false,
    statusText: "",
    secondaryText: "",
    processing: false,
    sessionReady: false,
    inputText: "",
    question: null,
    savedResult: null,
    primaryLabel: "重新提交",
    secondaryLabel: "返回输入",
    micReady: false,
    micWillCancel: false,
    notice: null,
    steps: [],
  },
  _guard: null,
  _sessionScope: null,
  _draft: null,
  _authFailed: false,
  _resumePending: false,
  _recordReturnState: "INPUT",

  /** 初始化当前页面的请求作用域。 */
  onLoad() {
    this._guard = new PageScope();
  },
  /** 回到页面后恢复本轮输入或尚未取回的结果。 */
  onShow() {
    registerNotice(bindNotice(this));
    this._guard.show();
    this.activate();
  },
  /** 确认登录与当前家庭，并接续页面内保留的本轮数据。 */
  async activate() {
    const guard = this._guard;
    guard.invalidate();
    const frame = guard.frame();
    this._authFailed = false;
    this.setData({ sessionReady: false });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this.setData({ state: "FAILED", processing: false, statusText: "登录失败，请重试", primaryLabel: "重试登录", secondaryLabel: "" });
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    if (!scope.userId || !scope.familyId) {
      this._sessionScope = null;
      this.setData({ state: "FAILED", processing: false, statusText: "请先登录并创建或加入家庭", primaryLabel: "前往首页", secondaryLabel: "" });
      return;
    }
    this._sessionScope = scope;
    if (this._draft && !store.isCurrentScope(this._draft.scope)) this._draft = null;
    this.setData({ sessionReady: true, processing: false });
    if (!this._draft) {
      this.onNext();
      return;
    }
    if (this._resumePending) {
      this._resumePending = false;
      this.submit();
    }
  },
  /** 临时离开时停止录音和前端等待，保留本轮内容。 */
  onHide() {
    registerNotice(null);
    this._resumePending = this.data.processing || this._resumePending;
    this.onRecordCancel();
    this._guard.hide();
  },
  /** 离开页面后结束本轮，不撤回已提交的操作。 */
  onUnload() {
    this.onHide();
    this._draft = null;
  },

  /** 判断页面当前是否可以接收用户输入。 */
  active() {
    return this._guard.isFrameCurrent(this._guard.frame()) && this.data.sessionReady &&
      !this.data.processing && !!this._sessionScope && store.isCurrentScope(this._sessionScope);
  },
  /** 家庭或账号改变时清空本轮界面。 */
  clearForScopeChange() {
    this._sessionScope = null;
    this._draft = null;
    this._resumePending = false;
    this.setData({
      state: "FAILED", photoPath: "", cameraOpen: false, processing: false, sessionReady: false,
      question: null, savedResult: null, inputText: "", steps: [],
      statusText: "状态已变化，请重试", primaryLabel: "重试", secondaryLabel: "",
    });
  },
  /** 显示相机不可用提示。 */
  onCameraError() {
    this.setData({ cameraError: true });
  },
  /** 打开微信权限设置。 */
  openSetting() {
    wx.openSetting();
  },
  /** 用户点击后打开取景，再次点击快门拍照。 */
  takePhoto() {
    if (!this.active()) return;
    if (!this.data.cameraOpen) {
      this.setData({ cameraOpen: true, cameraError: false });
      return;
    }
    const frame = this._guard.frame();
    wx.createCameraContext().takePhoto({
      quality: "normal",
      success: (res) => {
        if (this._guard.isFrameCurrent(frame)) this.acceptPhoto(res.tempImagePath);
      },
    });
  },
  /** 从相册选图，保留打开相册前的对话。 */
  chooseFromAlbum() {
    if (!this.active()) return;
    const scope = this._sessionScope;
    wx.chooseMedia({
      count: 1, mediaType: ["image"], sizeType: ["compressed"], sourceType: ["album"],
      success: (res) => {
        if (this._draft && store.isCurrentScope(scope)) this.acceptPhoto(res.tempFiles[0].tempFilePath);
      },
    });
  },
  /** 接收新照片；补拍阶段直接接续已确定的操作。 */
  acceptPhoto(path) {
    const draft = this._draft;
    draft.photoPath = path;
    draft.imageToken = null;
    draft.photoPending = true;
    this.setData({ photoPath: path, cameraOpen: false, secondaryText: "" });
    if (this.data.state === "PHOTO") this.submit({ event: "photo" });
  },
  /** 只更换待提交照片，保留本轮问答。 */
  retake() {
    if (!this.active()) return;
    this._draft.photoPath = "";
    this._draft.imageToken = null;
    this._draft.photoPending = false;
    this.setData({ photoPath: "", cameraOpen: true, cameraError: false });
  },

  /** 记录开始前的输入阶段，供取消或完成后返回。 */
  onRecordStart() {
    if (!this.active()) return;
    this._recordReturnState = this.data.state;
    this.setData({ state: "RECORDING", micReady: false, micWillCancel: false });
  },
  /** 显示录音就绪状态。 */
  onRecordReady() {
    if (this.data.state === "RECORDING") this.setData({ micReady: true });
  },
  /** 显示上滑取消状态。 */
  onRecordMove(e) {
    if (this.data.state === "RECORDING") this.setData({ micWillCancel: !!e.detail.willCancel });
  },
  /** 取消录音后回到原输入阶段。 */
  onRecordCancel() {
    if (this.data.state === "RECORDING") {
      this.setData({ state: this._recordReturnState, micReady: false, micWillCancel: false });
    }
  },
  /** 录音失败时保留本轮并提示重新录音。 */
  onRecordError() {
    this.onRecordCancel();
    showNotice("录音失败，请重试");
  },
  /** 麦克风未授权时返回原输入阶段。 */
  onPermissionDenied() {
    this.onRecordCancel();
    showNotice("需要麦克风权限，也可以点击键盘图标输入文字");
  },
  /** 将录音作为首次描述、补充描述或修改要求提交。 */
  onRecordFinish(e) {
    if (!this.active()) return;
    this.onRecordCancel();
    const event = this.descriptionEvent();
    this.submit({ event, audioPath: e.detail.tempFilePath });
  },
  /** 为首次描述、追问和修改选择统一的提交事件。 */
  descriptionEvent() {
    return this.data.state === "MODIFY" ? "revise" : this._draft.sessionId ? "reply" : "start";
  },
  /** 更新文字输入。 */
  onTextInput(e) {
    this.setData({ inputText: e.detail.value });
  },
  /** 提交首次、补充或修改文字，修改阶段也支持只更换照片。 */
  onTextSubmit() {
    if (!this.active()) return;
    const transcript = this.data.inputText.trim();
    if (!transcript && !(this.data.state === "MODIFY" && this._draft.photoPending)) {
      showNotice(this.data.state === "MODIFY" ? "请输入要修改的内容" : this._draft.sessionId ? "请输入要补充的内容" : "请输入物品、位置或要进行的操作");
      return;
    }
    this.submit({ event: this.descriptionEvent(), transcript: transcript || null });
  },
  /** 提交用户明确选择的操作。 */
  onOperationSelect(e) {
    if (this.active()) this.submit({ event: "choose_operation", operation: e.currentTarget.dataset.operation });
  },
  /** 提交用户明确选择的候选物品。 */
  onItemSelect(e) {
    if (this.active()) this.submit({ event: "choose_item", target_item_id: Number(e.currentTarget.dataset.id) });
  },
  /** 打开修改输入，不撤回最近保存的结果。 */
  onModify() {
    if (!this.active()) return;
    this.setData({ state: "MODIFY", question: null, inputText: "", secondaryText: "", cameraOpen: false });
  },
  /** 清空本轮页面数据并打开相机，开始下一条。 */
  onNext() {
    if (!this.active()) return;
    this._guard.invalidate();
    this._resumePending = false;
    this._draft = {
      scope: this._sessionScope, sessionId: null, photoPath: "", imageToken: null,
      photoPending: false, pending: null, key: null, frozen: null, inputState: "INPUT",
    };
    this.setData({
      state: "INPUT", photoPath: "", cameraOpen: true, cameraError: false, inputText: "",
      question: null, savedResult: null, statusText: "", secondaryText: "", steps: [],
      primaryLabel: "重新提交", secondaryLabel: "返回输入", micReady: false, micWillCancel: false,
    });
  },
  /** 更新当前请求的进度展示。 */
  _setStep(key, status, detail) {
    this.setData({ steps: this.data.steps.map((s) =>
      s.key === key ? { ...s, status, detail: detail !== undefined ? detail : s.detail } : s) });
  },
  /** 保留输入和已保存结果，提供重试或返回输入。 */
  fail(err, draft) {
    const message = err instanceof ApiError ? err.message : "处理失败，请重试";
    if (err instanceof ApiError && err.code === "IMAGE_INVALID") {
      draft.imageToken = null;
      draft.frozen = null;
      draft.key = newIdempotencyKey();
    }
    this.setData({
      state: "FAILED", processing: false, statusText: message, secondaryText: "", steps: [],
      primaryLabel: "重新提交", secondaryLabel: "返回输入",
    });
  },

  /** 提交本次输入，按明确状态展示结果；未知返回值进入失败提示。 */
  async submit(input) {
    const draft = this._draft;
    if (!draft || this.data.processing) return;
    if (input) {
      draft.pending = input;
      draft.key = newIdempotencyKey();
      draft.frozen = null;
      draft.inputState = this.data.state;
    }
    if (!draft.pending) return;
    if (!this.active()) {
      this._resumePending = true;
      return;
    }
    const guard = this._guard;
    guard.invalidate();
    const op = guard.capture();
    // 语音和收纳共用任务阶段展示，未知阶段直接交给现有失败提示。
    const onStage = (key, stage) => {
      if (!guard.isCurrent(op)) return;
      if (!Object.keys(STAGE_TEXT).includes(stage)) {
        throw new ApiError({ code: "INVALID_TASK_STAGE", message: `未知任务阶段 stage=${JSON.stringify(stage)}`, retryable: false });
      }
      this._setStep(key, "active", STAGE_TEXT[stage]);
    };
    const pending = draft.pending;
    const steps = [];
    if (draft.photoPending) steps.push({ key: "photo", label: "上传照片", status: draft.imageToken ? "done" : "active", detail: "" });
    if (pending.audioPath) steps.push({ key: "speech", label: "语音转写", status: pending.transcript ? "done" : "active", detail: "" });
    steps.push({ key: "judge", label: "整理内容", status: "pending", detail: "" });
    this.setData({ state: "UPLOADING", processing: true, statusText: "正在处理", secondaryText: "", steps });
    try {
      if (!draft.frozen) {
        const jobs = [];
        if (draft.photoPending && !draft.imageToken) {
          jobs.push({ key: "photo", promise: guard.run(op, (hooks) => uploadImage(draft.scope.familyId, draft.photoPath, {
            ...hooks,
            onProgress: (p) => {
              if (guard.isCurrent(op)) this._setStep("photo", "active", `${p}%`);
            },
          })) });
        }
        if (pending.audioPath && !pending.transcript) {
          jobs.push({ key: "speech", promise: guard.run(op, (hooks) => transcribeAudio(pending.audioPath, {
            ...hooks,
            onStage: (stage) => onStage("speech", stage),
          })) });
        }
        const results = await Promise.allSettled(jobs.map((job) => job.promise));
        if (guard.scopeChanged(op)) { this.clearForScopeChange(); return; }
        if (!guard.isCurrent(op)) return;
        let error = null;
        results.forEach((result, i) => {
          const key = jobs[i].key;
          if (result.status === "fulfilled") {
            if (key === "photo") draft.imageToken = result.value.image_token;
            else pending.transcript = result.value.transcript;
            this._setStep(key, "done", "");
          } else {
            this._setStep(key, "failed", "");
            error = error || result.reason;
          }
        });
        if (error) throw error;
        draft.frozen = {
          family_id: draft.scope.familyId, session_id: draft.sessionId, event: pending.event,
          transcript: pending.transcript || null, operation: pending.operation || null,
          target_item_id: pending.target_item_id || null,
          image_token: draft.photoPending ? draft.imageToken : null,
        };
      }
      this.setData({ state: "SAVING", statusText: "正在处理" });
      this._setStep("judge", "active", "排队中");
      const result = await guard.run(op, (hooks) => recordItem(draft.frozen, draft.key, {
        ...hooks,
        onStage: (stage) => onStage("judge", stage),
      }));
      if (guard.scopeChanged(op)) { this.clearForScopeChange(); return; }
      if (!guard.isCurrent(op)) return;
      let nextState;
      switch (result?.status) {
        case "saved":
          if (!["create", "delete", "move"].includes(result.operation)) {
            throw new ApiError({ code: "INVALID_RECORD_OPERATION", message: `未知收纳操作 operation=${JSON.stringify(result.operation)}；返回结果：${JSON.stringify(result)}`, retryable: false });
          }
          nextState = "SAVED";
          break;
        case "ask":
          nextState = "ASK";
          break;
        case "need_photo":
          nextState = "PHOTO";
          break;
        default:
          throw new ApiError({ code: "INVALID_RECORD_STATUS", message: `未知收纳状态 status=${JSON.stringify(result?.status)}；返回结果：${JSON.stringify(result)}`, retryable: false });
      }
      draft.sessionId = result.session_id;
      draft.pending = null;
      draft.frozen = null;
      draft.imageToken = null;
      draft.photoPending = false;
      this.setData({
        state: nextState,
        processing: false, cameraOpen: false, inputText: "", statusText: "", secondaryText: "", steps: [],
        question: result.status === "saved" ? null : result,
        savedResult: result.status === "saved" ? result : this.data.savedResult,
        photoPath: result.status === "saved" ? result.item.image_url : this.data.photoPath,
      });
    } catch (err) {
      if (guard.scopeChanged(op)) { this.clearForScopeChange(); return; }
      if (!guard.isCurrent(op)) return;
      this.fail(err, draft);
    }
  },
  /** 使用原请求重试，登录失败时先恢复登录。 */
  onRetry() {
    if (this.data.processing) return;
    if (!this._authFailed && store.user && !store.currentFamilyId) {
      wx.switchTab({ url: "/pages/home/index" });
      return;
    }
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      this.activate();
      return;
    }
    this.submit();
  },
  /** 返回本次输入阶段，允许调整失败请求的内容。 */
  onSecondary() {
    if (!this.active()) return;
    this.setData({ state: this._draft.inputState, inputText: this._draft.pending.transcript || "", statusText: "", steps: [] });
  },
});
