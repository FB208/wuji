const { ApiError, request } = require("../../services/api");
const { ensureLogin, applyDefaultFamily } = require("../../services/auth");
const { PageScope } = require("../../services/page-scope");
const { store } = require("../../store/index");

Page({
  data: {
    rows: [],
    ready: false,
    busy: false,
    noFamily: false,
    errorText: "",
    savingDefaultId: 0,
  },
  _guard: null,
  _sessionScope: null,
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
    if (!guard.isFrameCurrent(guard.frame())) return;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    this.setData({ busy: true, ready: false, rows: [], errorText: "", savingDefaultId: 0 });
    try {
      await ensureLogin({ refresh: true });
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({ busy: false, ready: false, errorText: "加载失败，请重试" });
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
      rows: this.familyRows(),
    });
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
      !this.data.savingDefaultId &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },

  /** 从最新账号资料派生当前家庭和默认家庭两个独立标记。 */
  familyRows() {
    return store.families.map((family) => ({
      ...family,
      current: family.id === store.currentFamilyId,
      isDefault: family.id === store.user.default_family_id,
    }));
  },

  /** 保存默认家庭，不触发行点击和当前家庭切换。 */
  async onSetDefault(e) {
    if (!this.active()) return;
    const id = Number(e.currentTarget.dataset.id);
    if (!this.data.rows.some((row) => row.id === id) || store.user.default_family_id === id) return;
    const guard = this._guard;
    const op = guard.capture();
    this.setData({ savingDefaultId: id });
    try {
      const data = await guard.run(op, (hooks) => request({
        path: "/me/default-family",
        method: "POST",
        data: { family_id: id },
        isCancelled: hooks.isCancelled,
        onTask: hooks.onTask,
      }));
      if (!guard.isCurrent(op)) return;
      applyDefaultFamily(op.scope.userId, data.default_family_id);
      this.setData({ rows: this.familyRows() });
      wx.showToast({ title: "已设为默认", icon: "success" });
    } catch (err) {
      if (!guard.isCurrent(op)) return;
      wx.showToast({ title: err instanceof ApiError ? err.message : "设置失败，请重试", icon: "none" });
      if (err instanceof ApiError && (err.statusCode === 403 || err.statusCode === 404)) {
        await this.activate();
      }
    } finally {
      if (guard.isFrameCurrent(op.generation)) {
        this.setData({ savingDefaultId: 0 });
        if (!store.isCurrentScope(op.scope)) this.activate();
      }
    }
  },

  onPick(e) {
    if (!this.active()) return;
    const id = Number(e.currentTarget.dataset.id);
    if (!id || !this.data.rows.some((r) => r.id === id) || !store.families.some((f) => f.id === id)) return;
    const uid = store.user ? store.user.id : 0;
    // 切换后立即刷新数据范围（文档 7.4）
    store.setCurrentFamily(id);
    if (store.currentFamilyId !== id) return;
    const guard = this._guard;
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
    const guard = this._guard;
    if (guard.isFrameCurrent(guard.frame()) && !this.data.busy) this.activate();
  },
  goProfile() {
    if (!this.active() || !this._sessionScope.userId) return;
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
