/** P05 物品列表：搜索、分页、下拉刷新、上拉加载（文档 6.1 / 8.4）。 */
import { request, getToken, showApiError } from "../../services/api";
import { store } from "../../store/index";
import { formatTime } from "../../utils/format";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

Page({
  data: {
    items: [] as any[],
    keyword: "",
    total: 0,
    loading: false,
    loaded: false,
    hasMore: true,
  },
  _page: 1,
  _debounceTimer: 0 as any,
  _familyIdAtLoad: 0,

  onShow() {
    if (!getToken()) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    // 家庭组切换后自动清空并重新加载（文档 8.4）
    if (this._familyIdAtLoad !== store.currentFamilyId) {
      this._familyIdAtLoad = store.currentFamilyId;
      this.setData({ items: [], loaded: false });
    }
    this.reload();
  },
  async onPullDownRefresh() {
    await this.reload();
    wx.stopPullDownRefresh();
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadPage(this._page + 1);
    }
  },
  onSearchInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.reload(), SEARCH_DEBOUNCE_MS);
  },
  async reload() {
    this._page = 1;
    await this.loadPage(1, true);
  },
  async loadPage(page: number, replace = false) {
    if (!store.currentFamilyId) return;
    this.setData({ loading: true });
    try {
      const q = encodeURIComponent(this.data.keyword.trim());
      const data = await request<{ items: any[]; total: number }>({
        path: `/items?family_id=${store.currentFamilyId}&q=${q}&page=${page}&page_size=${PAGE_SIZE}`,
      });
      const mapped = data.items.map((i) => ({ ...i, updated_at_text: formatTime(i.updated_at) }));
      this._page = page;
      this.setData({
        items: replace ? mapped : this.data.items.concat(mapped),
        total: data.total,
        hasMore: page * PAGE_SIZE < data.total,
        loaded: true,
      });
    } catch (err) {
      showApiError(err);
    } finally {
      this.setData({ loading: false });
    }
  },
  onItemTap(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${e.detail.item.id}` });
  },
  goRecord() {
    wx.navigateTo({ url: "/pages/record/index" });
  },
});
