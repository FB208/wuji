/** P07 修改物品：名称、位置必填，照片可重拍，记录文字只读（文档 6.3）。 */
import { request, showApiError } from "../../services/api";
import { uploadImage } from "../../services/upload";
import { store } from "../../store/index";

Page({
  data: {
    name: "",
    locationText: "",
    recordText: "",
    imageUrl: "",
    newPhotoPath: "",
    saving: false,
  },
  _id: 0,

  async onLoad(query: Record<string, string>) {
    this._id = Number(query.id || 0);
    try {
      const item = await request<any>({
        path: `/items/${this._id}?family_id=${store.currentFamilyId}`,
      });
      this.setData({
        name: item.name,
        locationText: item.location_text,
        recordText: item.record_text,
        imageUrl: item.image_url,
      });
    } catch (err) {
      showApiError(err);
    }
  },
  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value });
  },
  onLocationInput(e: WechatMiniprogram.Input) {
    this.setData({ locationText: e.detail.value });
  },
  retakePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: (res) => {
        this.setData({ newPhotoPath: res.tempFiles[0].tempFilePath });
      },
    });
  },
  async onSave() {
    const name = this.data.name.trim();
    const location = this.data.locationText.trim();
    if (!name || name.length > 128) {
      wx.showToast({ title: "名称需为 1～128 个字符", icon: "none" });
      return;
    }
    if (!location || location.length > 255) {
      wx.showToast({ title: "位置需为 1～255 个字符", icon: "none" });
      return;
    }
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      let imageToken: string | null = null;
      if (this.data.newPhotoPath) {
        const upload = await uploadImage(store.currentFamilyId, this.data.newPhotoPath);
        imageToken = upload.image_token;
      }
      await request({
        path: `/items/${this._id}?family_id=${store.currentFamilyId}`,
        method: "POST",
        data: {
          name,
          location_text: location,
          image_token: imageToken,
        },
      });
      wx.showToast({ title: "已保存", icon: "none" });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      showApiError(err, "保存失败，请重试");
    } finally {
      this.setData({ saving: false });
    }
  },
});
