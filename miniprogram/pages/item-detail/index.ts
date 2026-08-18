/** P06 物品详情：查看、修改入口、删除（文档 6.2 / 6.4）。 */
import { request, showApiError } from "../../services/api";
import { store } from "../../store/index";
import { formatTime } from "../../utils/format";

Page({
  data: {
    item: null as any,
    updatedAtText: "",
    imageFailed: false,
  },
  _id: 0,

  onLoad(query: Record<string, string>) {
    this._id = Number(query.id || 0);
  },
  onShow() {
    this.refresh();
  },
  async refresh() {
    if (!this._id) return;
    try {
      const item = await request<any>({
        path: `/items/${this._id}?family_id=${store.currentFamilyId}`,
      });
      this.setData({ item, updatedAtText: formatTime(item.updated_at), imageFailed: false });
    } catch (err) {
      showApiError(err);
    }
  },
  onImageError() {
    this.setData({ imageFailed: true });
  },
  previewImage() {
    if (!this.data.item || this.data.imageFailed) return;
    wx.previewImage({ urls: [this.data.item.image_url] });
  },
  goEdit() {
    wx.navigateTo({ url: `/pages/item-edit/index?id=${this._id}` });
  },
  onDelete() {
    wx.showModal({
      title: "删除记录",
      content: "删除后将无法继续查找这件物品。",
      confirmText: "删除",
      confirmColor: "#e64340",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            path: `/items/${this._id}?family_id=${store.currentFamilyId}`,
            method: "DELETE",
          });
          wx.showToast({ title: "已删除", icon: "none" });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (err) {
          showApiError(err);
        }
      },
    });
  },
});
