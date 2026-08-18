/** P02 首页：家庭组、收起来、找东西、最近记录（文档 8.1）。 */
import { request, getToken, showApiError } from "../../services/api";
import { refreshMe } from "../../services/auth";
import { store } from "../../store/index";
import { formatTime } from "../../utils/format";

interface ItemData {
  id: number;
  name: string;
  location_text: string;
  image_url: string;
  updated_at: string;
}

Page({
  data: {
    familyName: "",
    recentItems: [] as any[],
    loaded: false,
  },
  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    this.refresh();
  },
  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },
  async refresh() {
    try {
      if (store.families.length === 0) {
        await refreshMe();
      }
      const family = store.currentFamily();
      this.setData({ familyName: family ? family.name : "" });
      if (!store.currentFamilyId) return;
      const data = await request<{ items: ItemData[] }>({
        path: `/items?family_id=${store.currentFamilyId}&page=1&page_size=3`,
      });
      this.setData({
        recentItems: data.items.map((i) => ({ ...i, updated_at_text: formatTime(i.updated_at) })),
        loaded: true,
      });
    } catch (err) {
      showApiError(err);
    }
  },
  onSwitchFamily() {
    const names = store.families.map((f) => f.name);
    if (names.length === 0) return;
    wx.showActionSheet({
      itemList: names.slice(0, 6),
      success: (res) => {
        const family = store.families[res.tapIndex];
        if (family && family.id !== store.currentFamilyId) {
          // 切换后立即刷新数据范围（文档 7.4）
          store.setCurrentFamily(family.id);
          this.setData({ recentItems: [] });
          this.refresh();
        }
      },
    });
  },
  goRecord() {
    wx.navigateTo({ url: "/pages/record/index" });
  },
  goSearch() {
    wx.navigateTo({ url: "/pages/search/index" });
  },
  onItemTap(e: WechatMiniprogram.CustomEvent) {
    const item = e.detail.item;
    wx.navigateTo({ url: `/pages/item-detail/index?id=${item.id}` });
  },
});
