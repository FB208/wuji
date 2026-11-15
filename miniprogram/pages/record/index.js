/** P03 收纳物品：拍照 → 按住说话 → 自动提交（文档 4 章）。 */
const { newIdempotencyKey, ApiError } = require("../../services/api");
const { ensureLogin } = require("../../services/auth");
const { uploadImage, transcribeAudio, recordItem } = require("../../services/upload");
const { PageScope } = require("../../services/page-scope");
const { bindNotice, registerNotice, showNotice } = require("../../services/notice");
const { store } = require("../../store/index");

// state: "CAMERA" | "READY" | "RECORDING" | "UPLOADING" | "SAVING" | "SUCCESS" | "FAILED"
// steps[].status: "pending" | "active" | "done" | "failed"
// _draft: { scope, photoPath, audioPath, imageToken, transcript, key, frozen }

/** 后端任务阶段 → 用户可见文案（不确定进度只报"在做什么"，不造假百分比） */
const STAGE_TEXT = {
  queued: "排队中",
  asr_submit: "提交语音",
  asr_submitted: "已提交",
  asr_polling: "处理中",
  judging: "整理内容",
  rejudging: "内容有变化，重新整理",
  writing: "写入记录",
};

Page({
  data: {
    state: "CAMERA",
    photoPath: "",
    cameraError: false,
    statusText: "",
    secondaryText: "",
    processing: false,
    sessionReady: false,
    imageProgress: 0,
    audioProgress: 0,
    primaryLabel: "",
    secondaryLabel: "",
    micReady: false,
    micWillCancel: false,
    notice: null,
    steps: [],
  },
  _guard: null,
  _sessionScope: null,
  _draft: null,
  _navTimer: null,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    registerNotice(bindNotice(this));
    this._guard.show();
    this.activate();
  },
  async activate() {
    const guard = this._guard;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    const draft = this._draft;
    let pendingBusy = false;
    if (draft) {
      pendingBusy = this.data.state === "UPLOADING" || this.data.state === "SAVING";
      if (pendingBusy) this.setData({ state: "FAILED", statusText: "提交被中断", primaryLabel: "重新提交", secondaryLabel: "", steps: [] });
    }
    this.setData({ photoPath: "", processing: pendingBusy, sessionReady: false });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({ state: "FAILED", statusText: "登录失败，请重试", primaryLabel: "重试登录", secondaryLabel: "" });
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    if (!scope.userId || !scope.familyId) {
      this._sessionScope = null;
      if (!scope.userId) {
        this.setData({ state: "FAILED", statusText: "登录状态需要确认", primaryLabel: "重试登录", secondaryLabel: "" });
      } else {
        this.setData({ state: "FAILED", statusText: "请先创建或加入家庭", primaryLabel: "前往首页", secondaryLabel: "" });
      }
      return;
    }
    this._sessionScope = scope;
    if (this._draft && !store.isCurrentScope(this._draft.scope)) {
      this._draft = null;
      this.setData({ state: "CAMERA", photoPath: "", processing: false, sessionReady: true });
      return;
    }
    const d = this._draft;
    if (d) {
      const restore = d.frozen || d.audioPath
        ? { state: "FAILED", statusText: "提交被中断", primaryLabel: "重新提交", secondaryLabel: "" }
        : { state: "READY", statusText: "", primaryLabel: "", secondaryLabel: "" };
      this.setData({ ...restore, photoPath: d.photoPath, processing: false, sessionReady: true });
    } else {
      this.setData({ state: "CAMERA", photoPath: "", processing: false, sessionReady: true });
    }
  },
  onHide() {
    registerNotice(null);
    if (this._navTimer !== null) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
    const holder = this.selectComponent && this.selectComponent("#h2t");
    if (holder && holder.interrupt) holder.interrupt();
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
      this.data.sessionReady &&
      !this.data.processing &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },
  clearForScopeChange() {
    this._sessionScope = null;
    this._draft = null;
    this.setData({
      state: "CAMERA", photoPath: "", processing: false, sessionReady: false,
      statusText: "状态已变化，请重试", primaryLabel: "重试", secondaryLabel: "", steps: [],
    });
  },

  onCameraError(e) {
    console.warn("camera组件错误", e && e.detail);
    this.setData({ cameraError: true });
  },
  openSetting() {
    wx.openSetting();
  },
  takePhoto() {
    if (!this.active() || this.data.state !== "CAMERA") return;
    const guard = this._guard;
    const frame = guard.frame();
    const uid = this._sessionScope.userId;
    wx.createCameraContext().takePhoto({
      quality: "normal",
      success: (res) => {
        const g = this._guard;
        if (!g.isFrameCurrent(frame) || !store.user || store.user.id !== uid) return;
        this.acceptPhoto(res.tempImagePath);
      },
    });
  },
  chooseFromAlbum() {
    if (!this.active() || this.data.state !== "CAMERA") return;
    // 系统相册会触发页面 onHide/onShow，代次必然失效，回调里只校验会话 scope
    const scope = this._sessionScope;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sizeType: ["compressed"],
      sourceType: ["album"],
      success: (res) => {
        if (!store.isCurrentScope(scope) || this.data.state !== "CAMERA") return;
        const path = res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].tempFilePath : "";
        if (!path) return;
        this.acceptPhoto(path);
      },
      fail: (err) => {
        if (!err || /cancel/.test(err.errMsg || "")) return;
        console.warn("chooseMedia失败", err);
      },
    });
  },
  acceptPhoto(path) {
    const draft = {
      scope: this._sessionScope,
      photoPath: path,
      audioPath: "",
      imageToken: "",
      transcript: "",
      key: "",
      frozen: null,
    };
    this._draft = draft;
    this.setData({ photoPath: path, state: "READY", statusText: "", secondaryText: "", primaryLabel: "", secondaryLabel: "" });
  },
  retake() {
    if (!this.active() || this.data.state !== "READY") return;
    this._draft = null;
    this.setData({ state: "CAMERA", photoPath: "", statusText: "", secondaryText: "" });
  },

  onRecordStart() {
    if (!this.active() || this.data.state !== "READY") return;
    this.setData({ state: "RECORDING", micReady: false, micWillCancel: false });
  },
  onRecordReady() {
    if (this.data.state === "RECORDING") this.setData({ micReady: true });
  },
  onRecordMove(e) {
    if (this.data.state === "RECORDING") this.setData({ micWillCancel: !!e.detail.willCancel });
  },
  onRecordCancel() {
    if (this.data.state === "RECORDING") this.setData({ state: "READY", micReady: false, micWillCancel: false });
  },
  onRecordError() {
    if (this.data.state === "RECORDING") {
      this.setData({ state: "READY", statusText: "", secondaryText: "录音失败，请重试", micReady: false, micWillCancel: false });
    }
  },
  onPermissionDenied() {
    if (this.data.state === "RECORDING" || this.data.state === "READY") {
      showNotice("需要麦克风权限");
      this.setData({ state: "READY", secondaryText: "需要麦克风权限", micReady: false, micWillCancel: false });
    }
  },
  onRecordFinish(e) {
    if (!this.active() || (this.data.state !== "READY" && this.data.state !== "RECORDING")) return;
    const audioPath = e.detail.tempFilePath;
    const draft = this._draft;
    if (!audioPath || !draft || !store.isCurrentScope(draft.scope)) return;
    draft.audioPath = audioPath;
    draft.key = newIdempotencyKey();
    draft.transcript = "";
    draft.frozen = null;
    this.setData({ micReady: false, micWillCancel: false });
    this.submit();
  },

  _setStep(key, status, detail) {
    const steps = this.data.steps.map((s) =>
      s.key === key ? { ...s, status, detail: detail !== undefined ? detail : s.detail } : s
    );
    this.setData({ steps });
  },

  fail(err, draft) {
    const code = err instanceof ApiError ? err.code : "";
    const message = err instanceof ApiError ? err.message : "处理失败，请重试";
    if (code === "IMAGE_INVALID") {
      this._draft = null;
      this.setData({ state: "CAMERA", photoPath: "", processing: false, statusText: "", secondaryText: message, steps: [] });
      return;
    }
    if (code === "TRANSCRIBE_FAILED" || code === "RECORD_PARSE_FAILED" || code === "RECORD_UNCLEAR") {
      draft.audioPath = "";
      draft.key = "";
      draft.transcript = "";
      draft.frozen = null;
      showNotice(message);
      this.setData({ state: "READY", processing: false, statusText: "", secondaryText: message, steps: [] });
      return;
    }
    this.setData({ state: "FAILED", processing: false, statusText: "", primaryLabel: "重新提交", secondaryLabel: message });
  },

  async submit() {
    const guard = this._guard;
    const draft = this._draft;
    if (!draft || !draft.frozen && !draft.audioPath || !store.isCurrentScope(draft.scope)) return;
    if (this.data.state === "UPLOADING" || this.data.state === "SAVING") return;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return;
    const fid = draft.frozen ? draft.frozen.family_id : draft.scope.familyId;
    const steps = [
      { key: "photo", label: "上传照片", status: draft.imageToken ? "done" : "active", detail: "" },
      { key: "audio", label: "上传语音", status: draft.transcript ? "done" : "active", detail: "" },
      { key: "asr", label: "处理语音", status: draft.transcript ? "done" : "pending", detail: "" },
      { key: "judge", label: "整理并写入", status: "pending", detail: "" },
    ];
    this.setData({ state: "UPLOADING", processing: true, statusText: "正在上传", secondaryText: "", imageProgress: 0, audioProgress: 0, steps });
    try {
      if (!draft.frozen) {
        const results = await Promise.allSettled([
          draft.imageToken ? Promise.resolve({ image_token: draft.imageToken }) : guard.run(op, (hooks) =>
            uploadImage(fid, draft.photoPath, {
              isCancelled: hooks.isCancelled,
              onTask: hooks.onTask,
              onProgress: (p) => {
                if (guard.isFrameCurrent(op.generation)) {
                  this.setData({ imageProgress: p });
                  this._setStep("photo", "active", `${p}%`);
                }
              },
            })
          ),
          draft.transcript ? Promise.resolve({ transcript: draft.transcript }) : guard.run(op, (hooks) =>
            transcribeAudio(draft.audioPath, {
              isCancelled: hooks.isCancelled,
              onTask: hooks.onTask,
              onProgress: (p) => {
                if (guard.isFrameCurrent(op.generation)) {
                  this.setData({ audioProgress: p });
                  this._setStep("audio", "active", `${p}%`);
                }
              },
              onStage: (stage, detail) => {
                if (!guard.isFrameCurrent(op.generation)) return;
                this._setStep("audio", "done", "");
                const text = stage === "asr_polling" && detail
                  ? `处理中 · 第${detail}轮`
                  : STAGE_TEXT[stage] || "处理中";
                this._setStep("asr", "active", text);
              },
            })
          ),
        ]);
        if (guard.scopeChanged(op)) {
          this.clearForScopeChange();
          return;
        }
        if (!guard.isCurrent(op)) return;
        if (results[0].status === "fulfilled" && !draft.imageToken) {
          draft.imageToken = results[0].value.image_token;
          this._setStep("photo", "done", "");
        }
        if (results[1].status === "fulfilled" && !draft.transcript) {
          draft.transcript = results[1].value.transcript;
          this._setStep("asr", "done", "");
        }
        const failed = results.find((r) => r.status === "rejected");
        if (failed) {
          if (results[0].status === "rejected") this._setStep("photo", "failed");
          if (results[1].status === "rejected") {
            const audioStep = this.data.steps.find((s) => s.key === "audio");
            this._setStep(audioStep && audioStep.status === "done" ? "asr" : "audio", "failed");
          }
          this.fail(failed.reason, draft);
          return;
        }
        draft.frozen = { family_id: fid, image_token: draft.imageToken, transcript: draft.transcript };
      }
      if (!guard.isCurrent(op)) return;
      this.setData({ state: "SAVING", statusText: "正在入库" });
      this._setStep("judge", "active", STAGE_TEXT.queued);
      await guard.run(op, (hooks) =>
        recordItem(fid, draft.frozen.image_token, draft.frozen.transcript, draft.key, {
          isCancelled: hooks.isCancelled,
          onStage: (stage, detail) => {
            if (!guard.isFrameCurrent(op.generation)) return;
            const text = stage === "asr_polling" && detail
              ? `处理中 · 第${detail}轮`
              : STAGE_TEXT[stage] || "";
            this._setStep("judge", "active", text || undefined);
          },
        })
      );
      this._setStep("judge", "done", "");
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      this.setData({ state: "SUCCESS", processing: false, statusText: "入库完成", secondaryText: draft.frozen.transcript, steps: [] });
      this._navTimer = setTimeout(() => {
        this._navTimer = null;
        const g = this._guard;
        if (!g.isFrameCurrent(op.generation)) return;
        wx.switchTab({ url: "/pages/home/index" });
      }, 1000);
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      if (this.data.state === "SAVING") this._setStep("judge", "failed");
      this.fail(err, draft);
    }
  },

  onRetry() {
    const guard = this._guard;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.processing) return;
    if (!this._authFailed && store.user && !store.currentFamilyId) {
      wx.switchTab({ url: "/pages/home/index" });
      return;
    }
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      this.activate();
      return;
    }
    const draft = this._draft;
    if (!draft || !store.isCurrentScope(draft.scope)) {
      this.activate();
      return;
    }
    this.submit();
  },
  onSecondary() {
    if (!this.active()) return;
    wx.switchTab({ url: "/pages/home/index" });
  },
});
