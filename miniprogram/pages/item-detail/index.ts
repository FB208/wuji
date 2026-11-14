/** P06 物品详情：查看、修改入口、删除（文档 6.2 / 6.4）。 */
import { request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";
import { formatTime } from "../../utils/format";

const NAV_DELAY_MS = 600;

Page({
  data: {
    item: null as any,
    updatedAtText: "",
    imageFailed: false,
    ready: false,
    busy: false,
    blocked: false,
    noFamily: false,
    deleting: false,
    deleted: false,
    needsRefresh: false,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _loaded: null as { scope: Scope; itemId: number; version: number } | null,
  _boundFamilyId: 0,
  _boundUserId: 0,
  _invalidRoute: false,
  _id: 0,
  _navTimer: null as any,
  _authFailed: false,

  onLoad(query: Record<string, string>) {
    this._guard = new PageScope();
    const id = Number(query && query.id);
    if (Number.isSafeInteger(id) && id > 0) {
      this._id = id;
    }
    if (query && query.family_id !== undefined) {
      const fid = Number(query.family_id);
      if (Number.isSafeInteger(fid) && fid > 0) {
        this._boundFamilyId = fid;
      } else {
        this._invalidRoute = true;
      }
    }
    if (!this._id || this._invalidRoute) {
      this.setData({ errorText: "参数错误", busy: false, blocked: true });
    }
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    if (!this._id || this._invalidRoute) return;
    this.activate();
  },
  async activate() {
    const guard = this._guard as PageScope;
    if (!this._id || this._invalidRoute || !guard.isFrameCurrent(guard.frame())) return;
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    this._loaded = null;
    this.setData({
      busy: true, ready: false, errorText: "",
      item: null, updatedAtText: "", imageFailed: false,
      deleting: false, noFamily: false, blocked: false,
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
      this.setData({ busy: false, ready: false, errorText: "请重新登录" });
      return;
    }
    this._sessionScope = scope;
    if (this._boundUserId && this._boundUserId !== scope.userId) {
      this.clearForScopeChange();
      return;
    }
    this._boundUserId = scope.userId;
    if (!scope.familyId) {
      this.setData({ busy: false, noFamily: true, errorText: "还没有家庭，请先创建或加入" });
      return;
    }
    if (!this._boundFamilyId) this._boundFamilyId = scope.familyId;
    if (this._boundFamilyId !== scope.familyId) {
      this.clearForScopeChange();
      return;
    }
    if (this.data.deleted) {
      this.setData({ busy: false, errorText: "记录已删除" });
      return;
    }
    await this.loadItem();
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
      !!this._loaded &&
      store.isCurrentScope(this._loaded.scope)
    );
  },
  clearForScopeChange() {
    (this._guard as PageScope).invalidate();
    if (this._navTimer !== null) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
    this._loaded = null;
    this._sessionScope = null;
    this.setData({
      item: null, updatedAtText: "", imageFailed: false,
      ready: false, busy: false, deleting: false,
      blocked: true, noFamily: false, deleted: false, needsRefresh: false,
      errorText: "状态已变化，请返回列表重新选择",
    });
  },
  async loadItem(): Promise<ScopeOperation | null> {
    const guard = this._guard as PageScope;
    if (!this._id || this._invalidRoute || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) return null;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.deleting || this.data.deleted) return null;
    if (this._boundFamilyId !== this._sessionScope.familyId || this._boundUserId !== this._sessionScope.userId) return null;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op) || this._boundFamilyId !== op.scope.familyId) return null;
    const fid = this._boundFamilyId;
    this._loaded = null;
    this.setData({ busy: true, ready: false, item: null, updatedAtText: "", imageFailed: false, errorText: "" });
    try {
      const item = await guard.run<any>(op, (hooks) =>
        request<any>({
          path: `/items/${this._id}?family_id=${fid}`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      if (!item || item.id !== this._id || !Number.isSafeInteger(item.version) || item.version <= 0) {
        this.setData({ busy: false, errorText: "数据异常" });
        return null;
      }
      this._loaded = { scope: op.scope, itemId: item.id, version: item.version };
      this.setData({
        item,
        updatedAtText: formatTime(item.updated_at),
        imageFailed: false,
        busy: false,
        ready: true,
        needsRefresh: false,
      });
      return op;
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      if (err instanceof ApiError && err.statusCode === 403) {
        try {
          await refreshMe();
        } catch (_) {}
        if (guard.scopeChanged(op)) {
          this.clearForScopeChange();
          return null;
        }
        if (!guard.isCurrent(op)) return null;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ busy: false, errorText: message });
      return null;
    }
  },
  onRetry() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || this.data.deleting) return;
    if (!this._id || this._invalidRoute || this.data.blocked || this.data.noFamily || this.data.deleted) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      this.activate();
      return;
    }
    this.loadItem();
  },
  onImageError(e: WechatMiniprogram.CustomEvent) {
    if (!this.active() || !this.data.item || !e || e.currentTarget.dataset.imageUrl !== this.data.item.image_url) return;
    this.setData({ imageFailed: true });
  },
  previewImage() {
    if (!this.active() || this.data.deleting || this.data.deleted || this.data.needsRefresh) return;
    if (!this.data.item || this.data.imageFailed) return;
    wx.previewImage({ urls: [this.data.item.image_url] });
  },
  goEdit() {
    if (!this.active() || this.data.deleting || this.data.deleted || this.data.needsRefresh) return;
    wx.navigateTo({ url: `/pages/item-edit/index?id=${this._id}&family_id=${this._boundFamilyId}` });
  },
  onDelete() {
    if (!this.active() || this.data.deleting || this.data.deleted || this.data.needsRefresh) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._boundFamilyId;
    const version = this._loaded!.version;
    let fired = false;
    wx.showModal({
      title: "删除记录",
      content: "删除后将无法继续查找这件物品。",
      confirmText: "删除",
      confirmColor: "#e64340",
      success: async (res) => {
        if (!res.confirm || fired) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || this.data.deleting || !store.user || store.user.id !== uid) return;
        fired = true;
        this.setData({ deleting: true });
        let sent = false;
        try {
          sent = true;
          await g.run(op, (hooks) =>
            request({
              path: `/items/${this._id}?family_id=${fid}&expected_version=${version}`,
              method: "DELETE",
              isCancelled: hooks.isCancelled,
              onTask: hooks.onTask,
            })
          );
          if (g.scopeChanged(op)) {
            this.clearForScopeChange();
            return;
          }
          if (!g.isCurrent(op) || !store.user || store.user.id !== uid) return;
          this.setData({ deleted: true, deleting: false });
          wx.showToast({ title: "已删除", icon: "none" });
          const timer = setTimeout(() => {
            if (this._navTimer !== timer) return;
            this._navTimer = null;
            const gg = this._guard as PageScope;
            if (!gg.isCurrent(op)) return;
            const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
            if (pages.length > 1) wx.navigateBack();
            else wx.switchTab({ url: "/pages/items/index" });
          }, NAV_DELAY_MS);
          this._navTimer = timer;
        } catch (err) {
          if (g.scopeChanged(op)) {
            this.clearForScopeChange();
            return;
          }
          if (!g.isCurrent(op)) return;
          if (err instanceof ApiError && err.statusCode === 409) {
            this.setData({ deleting: false, needsRefresh: true, errorText: "记录已被修改，请刷新最新记录" });
            return;
          }
          if (err instanceof ApiError && err.statusCode === 403) {
            try {
              await refreshMe();
            } catch (_) {}
            if (g.scopeChanged(op)) {
              this.clearForScopeChange();
              return;
            }
            if (!g.isCurrent(op)) return;
          }
          if (sent) {
            this.setData({ deleting: false, needsRefresh: true, errorText: "结果未确认，刷新查看" });
            return;
          }
          const message = err instanceof ApiError ? err.message : "删除失败，请重试";
          this.setData({ deleting: false, errorText: message });
        }
      },
    });
  },
  goItems() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    if (!store.user) wx.reLaunch({ url: "/pages/launch/index" });
    else wx.switchTab({ url: "/pages/items/index" });
  },
  goProfile() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy) return;
    if (!store.user) wx.reLaunch({ url: "/pages/launch/index" });
    else wx.switchTab({ url: "/pages/profile/index" });
  },
});
