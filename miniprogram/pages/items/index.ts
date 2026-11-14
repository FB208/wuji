/** P05 物品列表：搜索、分页、下拉刷新、上拉加载（文档 6.1 / 8.4）。 */
import { request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";
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
    hasMore: false,
    errorText: "",
    ready: false,
    busy: false,
    noFamily: false,
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _listOp: null as ScopeOperation | null,
  _query: "",
  _page: 0,
  _debounceTimer: null as any,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    this.resumeAuth();
  },
  async resumeAuth() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    const oldSession = this._sessionScope;
    this._authFailed = false;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._listOp = null;
    guard.invalidate();
    const frame = guard.frame();
    this.setData({ busy: true, ready: false });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({
        busy: false,
        ready: false,
        errorText: "登录失败，请重试",
        items: [],
        total: 0,
        loaded: false,
        hasMore: false,
        loading: false,
        noFamily: false,
      });
      if (err instanceof ApiError && err.code === "LOGIN_BLOCKED") {
        wx.reLaunch({ url: "/pages/launch/index" });
      }
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    if (!scope.userId) {
      this._sessionScope = null;
      this.setData({ busy: false, ready: false, items: [], total: 0, loaded: false });
      return;
    }
    this._sessionScope = scope;
    // 家庭组切换后自动清空并重新加载（文档 8.4）
    const scopeChanged =
      !oldSession ||
      oldSession.userId !== scope.userId ||
      oldSession.familyId !== scope.familyId ||
      oldSession.version !== scope.version;
    if (scopeChanged) {
      this._listOp = null;
      this._page = 0;
      this._query = "";
      this.setData({ items: [], total: 0, keyword: "", loaded: false, hasMore: false, loading: false, errorText: "" });
    }
    this.setData({ busy: false, ready: !!scope.familyId, noFamily: !scope.familyId });
    if (!scope.familyId) {
      return;
    }
    this.reload();
  },
  onHide() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    const guard = this._guard as PageScope;
    guard.hide();
  },
  onUnload() {
    this.onHide();
  },

  session(): Scope | null {
    const guard = this._guard as PageScope;
    if (!guard || !guard.isFrameCurrent(guard.frame())) return null;
    if (!this.data.ready || this.data.busy) return null;
    const s = this._sessionScope;
    if (!s || !store.isCurrentScope(s)) return null;
    return s;
  },

  async reload(): Promise<ScopeOperation | null> {
    const guard = this._guard as PageScope;
    if (!this.session()) return null;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    guard.invalidate();
    const op = guard.capture();
    const session = this._sessionScope;
    if (
      !guard.isCurrent(op) ||
      !session ||
      !session.familyId ||
      !store.isCurrentScope(session)
    ) {
      return null;
    }
    this._listOp = op;
    this._page = 0;
    this._query = this.data.keyword.trim();
    this.setData({ items: [], total: 0, loaded: false, hasMore: false, loading: false, errorText: "" });
    await this.loadPage(1, true, op);
    return op;
  },
  clearForScopeChange() {
    (this._guard as PageScope).invalidate();
    this._listOp = null;
    this._sessionScope = null;
    this._page = 0;
    this._query = "";
    this.setData({
      items: [],
      total: 0,
      keyword: "",
      loaded: false,
      hasMore: false,
      loading: false,
      errorText: "家庭已切换，请重新加载",
      ready: false,
      busy: false,
      noFamily: false,
    });
  },
  async loadPage(page: number, replace: boolean, op: ScopeOperation) {
    const guard = this._guard as PageScope;
    if (!guard.isCurrent(op)) return;
    const fid = op.scope.familyId;
    const q = this._query;
    this.setData({ loading: true, errorText: "" });
    try {
      const data = await guard.run<{ items: any[]; total: number }>(op, (hooks) =>
        request<{ items: any[]; total: number }>({
          path: `/items?family_id=${fid}&q=${encodeURIComponent(q)}&page=${page}&page_size=${PAGE_SIZE}`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      const mapped = data.items.map((i) => ({ ...i, updated_at_text: formatTime(i.updated_at) }));
      const merged = replace
        ? mapped
        : this.data.items.concat(
            mapped.filter((m) => !this.data.items.some((cur) => cur.id === m.id))
          );
      this._page = page;
      this.setData({
        items: merged,
        total: data.total,
        hasMore: page * PAGE_SIZE < data.total,
        loaded: true,
        loading: false,
        errorText: "",
      });
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      if (err instanceof ApiError && err.statusCode === 403) {
        try {
          await refreshMe();
        } catch (_) {}
        if (guard.scopeChanged(op)) {
          this.clearForScopeChange();
          return;
        }
        if (!guard.isCurrent(op)) return;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ loading: false, errorText: message });
    }
  },

  onReachBottom() {
    if (!this.session() || this.data.loading || !this.data.hasMore || !this._listOp) return;
    const op = this._listOp;
    if (!store.isCurrentScope(op.scope)) return;
    this.loadPage(this._page + 1, false, op);
  },
  onSearchInput(e: WechatMiniprogram.Input) {
    if (!this.session()) return;
    const guard = this._guard as PageScope;
    this.setData({ keyword: e.detail.value });
    guard.invalidate();
    this._listOp = null;
    this.setData({ items: [], total: 0, loaded: false, hasMore: false, loading: false, errorText: "" });
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    const timerOp = guard.capture();
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      const g = this._guard as PageScope;
      if (!g.isCurrent(timerOp)) return;
      if (!this.session()) return;
      this.reload();
    }, SEARCH_DEBOUNCE_MS);
  },
  async onPullDownRefresh() {
    const guard = this._guard as PageScope;
    if (!this.session()) {
      if (guard.isFrameCurrent(guard.frame())) wx.stopPullDownRefresh();
      return;
    }
    const op = await this.reload();
    if (op && guard.isCurrent(op)) {
      wx.stopPullDownRefresh();
    }
  },
  onRetry() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      if (!this.data.busy) this.resumeAuth();
      return;
    }
    if (!this.session()) return;
    this.reload();
  },
  onItemTap(e: WechatMiniprogram.CustomEvent) {
    if (!this.session()) return;
    const item = e.detail.item;
    if (!item || !this.data.items.some((i) => i.id === item.id)) return;
    wx.navigateTo({ url: `/pages/item-detail/index?id=${item.id}` });
  },
  goRecord() {
    const s = this.session();
    if (!s || !s.familyId) return;
    wx.navigateTo({ url: "/pages/record/index" });
  },
  goHome() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || !this._sessionScope || !this._sessionScope.userId || !store.isCurrentScope(this._sessionScope)) return;
    wx.switchTab({ url: "/pages/home/index" });
  },
});
