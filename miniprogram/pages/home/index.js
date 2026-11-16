/** P02 首页：家庭组、收起来、找东西、最近记录（文档 8.1）。 */
const { request, ApiError } = require("../../services/api");
const { ensureLogin, refreshMe } = require("../../services/auth");
const { PageScope } = require("../../services/page-scope");
const { store } = require("../../store/index");
const { formatTime } = require("../../utils/format");

Page({
  data: {
    familyName: "",
    recentItems: [],
    loaded: false,
    ready: false,
    busy: false,
    noFamily: false,
    errorText: "",
  },
  _guard: null,
  _sessionScope: null,
  _listOp: null,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    const guard = this._guard;
    guard.show();
    this.activate();
  },
  async activate() {
    const guard = this._guard;
    const oldSession = this._sessionScope;
    this._authFailed = false;
    this._listOp = null;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    this.setData({ busy: true, ready: false, familyName: "", recentItems: [], loaded: false, errorText: "" });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({ busy: false, ready: false, errorText: "登录失败，请重试" });
      if (err instanceof ApiError && err.code === "LOGIN_BLOCKED") {
        wx.reLaunch({ url: "/pages/launch/index" });
      }
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    if (!scope.userId) {
      this._sessionScope = null;
      this.setData({ busy: false, ready: false });
      return;
    }
    this._sessionScope = scope;
    const scopeChanged =
      !oldSession ||
      oldSession.userId !== scope.userId ||
      oldSession.familyId !== scope.familyId ||
      oldSession.version !== scope.version;
    if (scopeChanged) {
      this._listOp = null;
      this.setData({ familyName: "", recentItems: [], loaded: false, errorText: "" });
    }
    this.setData({ busy: false, ready: true, noFamily: !scope.familyId });
    if (!scope.familyId) {
      return;
    }
    await this.loadRecent(scope);
  },
  onHide() {
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
      this.data.ready &&
      !this.data.busy &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },

  async loadRecent(scope) {
    const guard = this._guard;
    if (!this.active() || !scope.familyId || !store.isCurrentScope(scope)) return null;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return null;
    this._listOp = op;
    const family = store.currentFamily();
    this.setData({ familyName: family ? family.name : "选择家庭", errorText: "" });
    try {
      const data = await guard.run(op, (hooks) =>
        request({
          path: `/items?family_id=${op.scope.familyId}&page=1&page_size=3`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this._listOp = null;
        this._sessionScope = null;
        this.setData({ familyName: "", recentItems: [], loaded: false, ready: false, errorText: "家庭已切换，请重试" });
        return op;
      }
      if (!guard.isCurrent(op)) return null;
      this.setData({
        recentItems: data.items.map((i) => ({ ...i, updated_at_text: formatTime(i.updated_at) })),
        loaded: true,
        errorText: "",
      });
      return op;
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this._listOp = null;
        this._sessionScope = null;
        this.setData({ familyName: "", recentItems: [], loaded: false, ready: false, errorText: "家庭已切换，请重试" });
        return op;
      }
      if (!guard.isCurrent(op)) return null;
      if (err instanceof ApiError && err.statusCode === 403) {
        try {
          await refreshMe();
        } catch (_) {}
        if (guard.scopeChanged(op)) {
          this._listOp = null;
          this._sessionScope = null;
          this.setData({ familyName: "", recentItems: [], loaded: false, ready: false, errorText: "家庭已切换，请重试" });
          return op;
        }
        if (!guard.isCurrent(op)) return null;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ errorText: message });
      return op;
    }
  },

  async onPullDownRefresh() {
    const guard = this._guard;
    if (!this.active() || !this._sessionScope.familyId) {
      if (guard.isFrameCurrent(guard.frame())) wx.stopPullDownRefresh();
      return;
    }
    const op = await this.loadRecent(this._sessionScope);
    if (op && guard.isFrameCurrent(op.generation)) {
      wx.stopPullDownRefresh();
    }
  },
  onRetry() {
    const guard = this._guard;
    if (!guard.isFrameCurrent(guard.frame())) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      if (!this.data.busy) this.activate();
      return;
    }
    if (!this.active()) return;
    this.loadRecent(this._sessionScope);
  },
  onSwitchFamily() {
    if (!this.active()) return;
    wx.navigateTo({ url: "/pages/family-list/index" });
  },
  goRecord() {
    if (!this.active()) return;
    if (!this._sessionScope.familyId) {
      this.goProfile();
      return;
    }
    wx.navigateTo({ url: "/pages/record/index" });
  },
  /** 导航不等待首页请求，目标页共享登录初始化。 */
  goSearch() {
    wx.navigateTo({ url: "/pages/search/index" });
  },
  onItemTap(e) {
    if (!this.active()) return;
    const item = e.detail.item;
    if (!item || !this.data.recentItems.some((i) => i.id === item.id)) return;
    wx.navigateTo({ url: `/pages/item-detail/index?id=${item.id}` });
  },
  goProfile() {
    if (!this.active() || !this._sessionScope.userId) return;
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
