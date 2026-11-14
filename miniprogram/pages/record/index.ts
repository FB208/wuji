/** P03 收纳物品：拍照 → 按住说话 → 自动提交（文档 4 章）。 */
import { request, newIdempotencyKey, ApiError } from "../../services/api";
import { ensureLogin } from "../../services/auth";
import { uploadImage, transcribeAudio } from "../../services/upload";
import { PageScope } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

type PageState = "CAMERA" | "READY" | "RECORDING" | "UPLOADING" | "SAVING" | "SUCCESS" | "FAILED";

interface Draft {
  scope: Scope;
  photoPath: string;
  audioPath: string;
  imageToken: string;
  transcript: string;
  key: string;
  frozen: { family_id: number; image_token: string; transcript: string } | null;
}

Page({
  data: {
    state: "CAMERA" as PageState,
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
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _draft: null as Draft | null,
  _navTimer: null as any,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    (this._guard as PageScope).show();
    this.activate();
  },
  async activate() {
    const guard = this._guard as PageScope;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    const draft = this._draft;
    let pendingBusy = false;
    if (draft) {
      pendingBusy = this.data.state === "UPLOADING" || this.data.state === "SAVING";
      if (pendingBusy) this.setData({ state: "FAILED", statusText: "提交被中断", primaryLabel: "重新提交", secondaryLabel: "" });
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
        ? { state: "FAILED" as PageState, statusText: "提交被中断", primaryLabel: "重新提交", secondaryLabel: "" }
        : { state: "READY" as PageState, statusText: "", primaryLabel: "", secondaryLabel: "" };
      this.setData({ ...restore, photoPath: d.photoPath, processing: false, sessionReady: true });
    } else {
      this.setData({ state: "CAMERA", photoPath: "", processing: false, sessionReady: true });
    }
  },
  onHide() {
    if (this._navTimer !== null) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
    const holder = (this as any).selectComponent && (this as any).selectComponent("#h2t");
    if (holder && holder.interrupt) holder.interrupt();
    (this._guard as PageScope).hide();
  },
  onUnload() {
    this.onHide();
  },

  active(): boolean {
    const guard = this._guard as PageScope;
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
      statusText: "状态已变化，请重试", primaryLabel: "重试", secondaryLabel: "",
    });
  },

  onCameraError() {
    this.setData({ cameraError: true });
  },
  openSetting() {
    wx.openSetting();
  },
  takePhoto() {
    if (!this.active() || this.data.state !== "CAMERA") return;
    const guard = this._guard as PageScope;
    const frame = guard.frame();
    const uid = this._sessionScope!.userId;
    wx.createCameraContext().takePhoto({
      quality: "high",
      success: (res) => {
        const g = this._guard as PageScope;
        if (!g.isFrameCurrent(frame) || !store.user || store.user.id !== uid) return;
        this.acceptPhoto(res.tempImagePath);
      },
    });
  },
  chooseFromAlbum() {
    if (!this.active() || this.data.state !== "CAMERA") return;
    const guard = this._guard as PageScope;
    const frame = guard.frame();
    const uid = this._sessionScope!.userId;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album"],
      success: (res) => {
        const g = this._guard as PageScope;
        if (!g.isFrameCurrent(frame) || !store.user || store.user.id !== uid) return;
        const path = res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].tempFilePath : "";
        if (!path) return;
        this.acceptPhoto(path);
      },
    });
  },
  acceptPhoto(path: string) {
    const draft: Draft = {
      scope: this._sessionScope!,
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
    this.setData({ state: "RECORDING" });
  },
  onRecordCancel() {
    if (this.data.state === "RECORDING") this.setData({ state: "READY" });
  },
  onRecordError() {
    if (this.data.state === "RECORDING") this.setData({ state: "READY", statusText: "", secondaryText: "录音失败，请重试" });
  },
  onPermissionDenied() {
    if (this.data.state === "RECORDING" || this.data.state === "READY") {
      this.setData({ state: "READY", secondaryText: "需要麦克风权限" });
    }
  },
  onRecordFinish(e: WechatMiniprogram.CustomEvent) {
    if (!this.active() || (this.data.state !== "READY" && this.data.state !== "RECORDING")) return;
    const audioPath = e.detail.tempFilePath;
    const draft = this._draft;
    if (!audioPath || !draft || !store.isCurrentScope(draft.scope)) return;
    draft.audioPath = audioPath;
    draft.key = newIdempotencyKey();
    draft.transcript = "";
    draft.frozen = null;
    this.submit();
  },

  fail(err: unknown, draft: Draft) {
    const code = err instanceof ApiError ? err.code : "";
    const message = err instanceof ApiError ? err.message : "处理失败，请重试";
    if (code === "IMAGE_INVALID") {
      this._draft = null;
      this.setData({ state: "CAMERA", photoPath: "", processing: false, statusText: "", secondaryText: message });
      return;
    }
    if (code === "TRANSCRIBE_FAILED" || code === "RECORD_PARSE_FAILED") {
      draft.audioPath = "";
      draft.key = "";
      draft.transcript = "";
      draft.frozen = null;
      this.setData({ state: "READY", processing: false, statusText: "", secondaryText: message });
      return;
    }
    this.setData({ state: "FAILED", processing: false, statusText: message, primaryLabel: "重新提交", secondaryLabel: "" });
  },

  async submit() {
    const guard = this._guard as PageScope;
    const draft = this._draft;
    if (!draft || !draft.frozen && !draft.audioPath || !store.isCurrentScope(draft.scope)) return;
    if (this.data.state === "UPLOADING" || this.data.state === "SAVING") return;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return;
    const fid = draft.frozen ? draft.frozen.family_id : draft.scope.familyId;
    this.setData({ state: "UPLOADING", processing: true, statusText: "正在上传", secondaryText: "", imageProgress: 0, audioProgress: 0 });
    try {
      if (!draft.frozen) {
        const results = await Promise.allSettled([
          draft.imageToken ? Promise.resolve({ image_token: draft.imageToken }) : guard.run<{ image_token: string }>(op, (hooks) =>
            uploadImage(fid, draft.photoPath, {
              isCancelled: hooks.isCancelled,
              onTask: hooks.onTask,
              onProgress: (p) => { if (guard.isFrameCurrent(op.generation)) this.setData({ imageProgress: p }); },
            })
          ),
          draft.transcript ? Promise.resolve({ transcript: draft.transcript }) : guard.run<{ transcript: string }>(op, (hooks) =>
            transcribeAudio(draft.audioPath, {
              isCancelled: hooks.isCancelled,
              onTask: hooks.onTask,
              onProgress: (p) => { if (guard.isFrameCurrent(op.generation)) this.setData({ audioProgress: p }); },
            })
          ),
        ]);
        if (guard.scopeChanged(op)) {
          this.clearForScopeChange();
          return;
        }
        if (!guard.isCurrent(op)) return;
        if (results[0].status === "fulfilled" && !draft.imageToken) {
          draft.imageToken = (results[0].value as { image_token: string }).image_token;
        }
        if (results[1].status === "fulfilled" && !draft.transcript) {
          draft.transcript = (results[1].value as { transcript: string }).transcript;
        }
        const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        if (failed) {
          this.fail(failed.reason, draft);
          return;
        }
        draft.frozen = { family_id: fid, image_token: draft.imageToken, transcript: draft.transcript };
      }
      if (!guard.isCurrent(op)) return;
      this.setData({ state: "SAVING", statusText: "正在入库" });
      await guard.run(op, (hooks) =>
        request({
          path: "/items/record",
          method: "POST",
          idempotencyKey: draft.key,
          data: draft.frozen as Record<string, any>,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      this.setData({ state: "SUCCESS", processing: false, statusText: "入库完成", secondaryText: draft.frozen.transcript });
      this._navTimer = setTimeout(() => {
        this._navTimer = null;
        const g = this._guard as PageScope;
        if (!g.isFrameCurrent(op.generation)) return;
        wx.switchTab({ url: "/pages/home/index" });
      }, 1000);
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      this.fail(err, draft);
    }
  },

  onRetry() {
    const guard = this._guard as PageScope;
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
