import { ApiError } from "../../services/api";
import { ensureLogin } from "../../services/auth";
import { PageScope } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

Page({
  data: {
    rows: [] as any[],
    ready: false,
    busy: false,
    noFamily: false,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    this.activate();
  },
  async activate() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    this.setData({ busy: true, ready: false, rows: [], errorText: "" });
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
    this.setData({
      busy: false,
      ready: true,
      noFamily: store.families.length === 0,
      rows: store.families.map((f) => ({ ...f, current: f.id === store.currentFamilyId })),
    });
  },
  onHide() {
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
      this.data.ready &&
      !this.data.busy &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },

  onPick(e: WechatMiniprogram.CustomEvent) {
    if (!this.active()) return;
    const id = Number(e.currentTarget.dataset.id);
    if (!id || !this.data.rows.some((r) => r.id === id) || !store.families.some((f) => f.id === id)) return;
    const uid = store.user ? store.user.id : 0;
    // 切换后立即刷新数据范围（文档 7.4）
    store.setCurrentFamily(id);
    if (store.currentFamilyId !== id) return;
    const guard = this._guard as PageScope;
    if (!store.user || store.user.id !== uid) return;
    if (!guard.isFrameCurrent(guard.frame())) return;
    const pages = getCurrentPages ? getCurrentPages() : [];
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: "/pages/home/index" });
    }
  },
  onRetryTap() {
    const guard = this._guard as PageScope;
    if (guard.isFrameCurrent(guard.frame()) && !this.data.busy) this.activate();
  },
  goProfile() {
    if (!this.active() || !this._sessionScope!.userId) return;
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
