/** P10 加入家庭组：校验令牌、显示家庭组名称、加入并切换（文档 7.3）。 */
import { request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

const TOKEN_MAX = 4096;
const NAV_DELAY_MS = 600;

Page({
  data: {
    familyName: "",
    ownerNickname: "",
    invalid: false,
    joining: false,
    joined: false,
    loaded: false,
    ready: false,
    busy: false,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _previewFID: 0,
  _token: "",
  _navTimer: null as any,
  _authFailed: false,

  onLoad(query: Record<string, string>) {
    this._guard = new PageScope();
    try {
      const raw = query && query.invite_token ? decodeURIComponent(query.invite_token) : "";
      this._token = raw.length > TOKEN_MAX ? "" : raw;
    } catch (_) {
      this._token = "";
    }
    if (!this._token) {
      this.setData({ invalid: true, loaded: true });
    }
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    if (!this._token) return;
    this.activate();
  },
  async activate() {
    const guard = this._guard as PageScope;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    this.setData({
      busy: true, ready: false, familyName: "", ownerNickname: "",
      loaded: false, joined: false, joining: false, errorText: "", invalid: false,
    });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({ busy: false, errorText: "登录失败，请重试" });
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
    this.setData({ busy: false, ready: true });
    await this.preview();
  },
  onHide() {
    if (this._navTimer !== null) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
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

  clearForScopeChange() {
    (this._guard as PageScope).invalidate();
    if (this._navTimer !== null) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
    this._sessionScope = null;
    this._previewFID = 0;
    this.setData({
      familyName: "", ownerNickname: "", loaded: false, ready: false,
      joining: false, joined: false, busy: false,
      errorText: "状态已变化，请重试",
    });
  },
  async preview(): Promise<ScopeOperation | null> {
    const guard = this._guard as PageScope;
    if (!this.active()) return null;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return null;
    const token = this._token;
    this._previewFID = 0;
    this.setData({ busy: true, loaded: false, errorText: "" });
    try {
      const preview = await guard.run<{ family_id: number; family_name: string; owner_nickname: string | null }>(op, (hooks) =>
        request<{ family_id: number; family_name: string; owner_nickname: string | null }>({
          path: `/families/invite-preview?invite_token=${encodeURIComponent(token)}`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      if (!Number.isSafeInteger(preview.family_id) || preview.family_id <= 0) {
        throw new ApiError({ code: "INVALID_RESPONSE", message: "邀请信息无效，请重试", retryable: false });
      }
      this._previewFID = preview.family_id;
      // 加入前必须显示家庭组名称（文档 14.3）
      this.setData({
        familyName: preview.family_name,
        ownerNickname: preview.owner_nickname || "",
        loaded: true,
        busy: false,
        errorText: "",
      });
      return op;
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      if (err instanceof ApiError && (err.code === "INVITE_INVALID" || err.code === "INVITE_EXPIRED")) {
        this.setData({ invalid: true, loaded: true, busy: false, errorText: "" });
        return null;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ busy: false, errorText: message });
      return null;
    }
  },

  async onJoin() {
    const guard = this._guard as PageScope;
    if (!this.active() || !this.data.loaded || this.data.invalid || this.data.errorText) return;
    if (this.data.joining || this.data.joined || !this._previewFID) return;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._previewFID;
    const token = this._token;
    this.setData({ joining: true, errorText: "" });
    let finishOp: ScopeOperation = op;
    try {
      const res = await guard.run<{ family_id: number }>(op, (hooks) =>
        request<{ family_id: number }>({
          path: "/families/join",
          method: "POST",
          data: { invite_token: token },
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op) || !store.user || store.user.id !== uid) return;
      if (res.family_id !== fid) {
        this.setData({ errorText: "加入失败，请重试", joining: false });
        return;
      }
      // 加入成功并切换家庭组（文档 7.3）
      await refreshMe(false, res.family_id);
      if (!guard.isFrameCurrent(op.generation)) return;
      if (!store.user || store.user.id !== uid) {
        this.clearForScopeChange();
        return;
      }
      const navOp = guard.capture();
      finishOp = navOp;
      this._sessionScope = store.captureScope();
      if (!guard.isCurrent(navOp)) return;
      this.setData({ joined: true });
      wx.showToast({ title: "加入成功", icon: "none" });
      this._navTimer = setTimeout(() => {
        this._navTimer = null;
        const g = this._guard as PageScope;
        if (!g.isCurrent(navOp)) return;
        wx.switchTab({ url: "/pages/home/index" });
      }, NAV_DELAY_MS);
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      const message = err instanceof ApiError ? err.message : "加入失败，请重试";
      this.setData({ errorText: message });
    } finally {
      const g = this._guard as PageScope;
      if (g.isCurrent(finishOp)) {
        this.setData({ joining: false });
      }
    }
  },
  onRetry() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    if (this.data.busy || this.data.joining || this.data.joined) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      this.activate();
      return;
    }
    if (!this.active()) return;
    this.preview();
  },
  goHome() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || this.data.joining) return;
    if (!store.user || !store.user.id) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    wx.switchTab({ url: "/pages/home/index" });
  },
});
