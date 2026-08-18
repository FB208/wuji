/** P08 个人中心：账号、家庭、数据、关于（文档 8.5）。 */
import { request, getToken, showApiError } from "../../services/api";
import { refreshMe } from "../../services/auth";
import { store } from "../../store/index";

Page({
  data: {
    nickname: "",
    avatarUrl: "",
    familyName: "",
    familyCount: 0,
    itemCount: 0,
    version: "V1.0",
  },
  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    this.refresh();
  },
  async refresh() {
    try {
      await refreshMe();
      const family = store.currentFamily();
      this.setData({
        nickname: store.user ? store.user.nickname || "微信用户" : "",
        avatarUrl: store.user ? store.user.avatar_url || "" : "",
        familyName: family ? family.name : "",
        familyCount: store.families.length,
      });
      if (store.currentFamilyId) {
        const data = await request<{ total: number }>({
          path: `/items?family_id=${store.currentFamilyId}&page=1&page_size=1`,
        });
        this.setData({ itemCount: data.total });
      }
    } catch (err) {
      showApiError(err);
    }
  },
  goFamily() {
    wx.navigateTo({ url: "/pages/family/index" });
  },
  onSwitchFamily() {
    const names = store.families.map((f) => f.name);
    if (names.length === 0) return;
    wx.showActionSheet({
      itemList: names.slice(0, 6),
      success: (res) => {
        const family = store.families[res.tapIndex];
        if (family) {
          store.setCurrentFamily(family.id);
          this.refresh();
        }
      },
    });
  },
  onCreateFamily() {
    wx.showModal({
      title: "创建家庭组",
      editable: true,
      placeholderText: "家庭组名称",
      success: async (res) => {
        const name = (res.content || "").trim();
        if (!res.confirm || !name) return;
        try {
          const family = await request<{ id: number }>({
            path: "/families",
            method: "POST",
            data: { name },
          });
          await refreshMe();
          store.setCurrentFamily(family.id);
          this.refresh();
          wx.showToast({ title: "已创建", icon: "none" });
        } catch (err) {
          showApiError(err);
        }
      },
    });
  },
  onPrivacy() {
    wx.showModal({
      title: "隐私说明",
      content:
        "照片仅用于保存和展示物品外观；语音仅用于转写为文字后记录和查找物品，转写完成后语音文件即被删除；家庭组成员可以访问该家庭组内全部物品记录。",
      showCancel: false,
    });
  },
  onFeedback() {
    wx.showToast({ title: "可通过小程序客服反馈问题", icon: "none" });
  },
});
