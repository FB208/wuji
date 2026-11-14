/** P01 启动与登录：登录完成后进入首页（文档 3.2 / 7.1）。 */
import { ApiError } from "../../services/api";
import { ensureLogin } from "../../services/auth";
import { PageScope } from "../../services/page-scope";
import { store } from "../../store/index";

Page({
  data: {
    failed: false,
    busy: false,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _navigating: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    this._navigating = false;
    this.setData({ busy: false });
    this.login(false);
  },
  onHide() {
    (this._guard as PageScope).hide();
    this._navigating = false;
  },
  onUnload() {
    this.onHide();
  },
  async login(interactive: boolean) {
    const guard = this._guard as PageScope;
    if (!guard || !guard.isFrameCurrent(guard.frame()) || this.data.busy || this._navigating) return;
    guard.invalidate();
    const frame = guard.frame();
    this.setData({ busy: true, failed: false, errorText: "" });
    try {
      await ensureLogin({ interactive });
      if (!guard.isFrameCurrent(frame)) return;
      const scope = store.captureScope();
      if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0) {
        this.setData({ busy: false, failed: true, errorText: "登录未完成，请重试" });
        return;
      }
      this._navigating = true;
      this.setData({ busy: false });
      wx.switchTab({
        url: "/pages/home/index",
        fail: () => {
          const g = this._guard as PageScope;
          if (!g.isFrameCurrent(frame)) return;
          this._navigating = false;
          this.setData({ busy: false, failed: true, errorText: "登录失败，请重试" });
        },
      });
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      const message = err instanceof ApiError && err.message ? err.message : "登录失败，请重试";
      this.setData({ busy: false, failed: true, errorText: message });
    }
  },
  onRetry() {
    const guard = this._guard as PageScope;
    if (!guard || !guard.isFrameCurrent(guard.frame()) || this.data.busy || this._navigating) return;
    this.login(true);
  },
});
