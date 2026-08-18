/** P03 收纳物品：拍照 → 按住说话 → 自动提交（文档 4 章）。 */
import { request, newIdempotencyKey, ApiError } from "../../services/api";
import { uploadImage, transcribeAudio } from "../../services/upload";
import { store } from "../../store/index";

type PageState =
  | "CAMERA"
  | "READY"
  | "RECORDING"
  | "UPLOADING"
  | "SAVING"
  | "SUCCESS"
  | "FAILED";

Page({
  data: {
    state: "CAMERA" as PageState,
    photoPath: "",
    cameraError: false,
    statusText: "",
    processing: false,
    failedMessage: "",
  },
  // 重试时复用的现场（文档 14.1：复用 Idempotency-Key）
  _audioPath: "",
  _idemKey: "",

  onCameraError() {
    // 相机权限关闭：展示说明并允许相册选择（文档 14.1）
    this.setData({ cameraError: true });
  },
  openSetting() {
    wx.openSetting({});
  },
  takePhoto() {
    const ctx = wx.createCameraContext();
    ctx.takePhoto({
      quality: "high",
      success: (res) => {
        this.setData({ state: "READY", photoPath: res.tempImagePath });
      },
      fail: () => {
        wx.showToast({ title: "拍照失败，请重试", icon: "none" });
      },
    });
  },
  chooseFromAlbum() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album"],
      success: (res) => {
        this.setData({ state: "READY", photoPath: res.tempFiles[0].tempFilePath });
      },
    });
  },
  retake() {
    this.setData({ state: "CAMERA", photoPath: "" });
  },
  onRecordStart() {
    this.setData({ state: "RECORDING" });
  },
  onRecordCancel() {
    this.setData({ state: "READY" });
  },
  onRecordError(e: WechatMiniprogram.CustomEvent) {
    this.setData({ state: "READY" });
    wx.showToast({ title: e.detail.message || "录音失败，请重试", icon: "none" });
  },
  onPermissionDenied() {
    wx.showModal({
      title: "需要麦克风权限",
      content: "请在设置中开启麦克风，用于说出物品和位置。",
      confirmText: "去设置",
      success: (res) => {
        if (res.confirm) wx.openSetting({});
      },
    });
  },
  onRecordFinish(e: WechatMiniprogram.CustomEvent) {
    // 松开即提交，不进入确认页（文档 4.1）
    this._audioPath = e.detail.tempFilePath;
    this._idemKey = newIdempotencyKey();
    this.submit();
  },
  async submit() {
    if (this.data.processing) return;
    this.setData({ processing: true, state: "UPLOADING", statusText: "正在上传", failedMessage: "" });

    const familyId = store.currentFamilyId;
    try {
      // 照片上传和语音转写并行执行（文档 11.3）
      const [image, speech] = await Promise.all([
        uploadImage(familyId, this.data.photoPath),
        transcribeAudio(this._audioPath),
      ]);

      this.setData({ state: "SAVING", statusText: "正在入库" });
      await request({
        path: "/items/record",
        method: "POST",
        data: {
          family_id: familyId,
          image_token: image.image_token,
          transcript: speech.transcript,
        },
        idempotencyKey: this._idemKey,
      });

      this.setData({ state: "SUCCESS", statusText: "入库完成", processing: false });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "入库失败，请重试";
      // 失败时照片和录音仍保留在当前页面（文档 4.3）
      this.setData({ state: "FAILED", statusText: message, failedMessage: message, processing: false });
    }
  },
  onRetry() {
    // 网络重试复用同一 Idempotency-Key，不会重复创建（文档 14.1）
    this.submit();
  },
});
