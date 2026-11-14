/** P09 家庭组管理：改名、邀请、成员管理、退出（文档 7.2 / 7.3）。 */
import { request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

interface Member {
  user_id: number;
  nickname: string | null;
  avatar_url: string | null;
  role: string;
  joined_at: string;
}

Page({
  data: {
    familyName: "",
    isOwner: false,
    members: [] as Member[],
    ready: false,
    busy: false,
    noFamily: false,
    currentUserId: 0,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _share: null as { scope: Scope; path: string; expiresAt: number } | null,
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
    this._authFailed = false;
    guard.invalidate();
    const frame = guard.frame();
    if (!guard.isFrameCurrent(frame)) return;
    this.clearShare();
    this.setData({ busy: true, ready: false, familyName: "", members: [], isOwner: false, errorText: "", noFamily: false, currentUserId: 0 });
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
    this.setData({ busy: false, ready: !!scope.familyId, noFamily: !scope.familyId, currentUserId: scope.userId });
    if (!scope.familyId) return;
    await this.loadMembers();
  },
  onHide() {
    this.clearShare();
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
      !this.data.errorText &&
      !!this._sessionScope &&
      store.isCurrentScope(this._sessionScope)
    );
  },
  clearShare() {
    this._share = null;
    try { wx.hideShareMenu(); } catch (_) {}
  },
  clearForScopeChange() {
    const guard = this._guard as PageScope;
    guard.invalidate();
    this.clearShare();
    this._sessionScope = null;
    this.setData({
      familyName: "", members: [], isOwner: false,
      ready: false, busy: false, noFamily: false, currentUserId: 0,
      errorText: "状态已变化，请重试",
    });
  },
  async loadMembers(op?: ScopeOperation): Promise<ScopeOperation | null> {
    const guard = this._guard as PageScope;
    const own = !op;
    if (own) {
      guard.invalidate();
      op = guard.capture();
    }
    if (!op || !guard.isCurrent(op) || !this._sessionScope || !this._sessionScope.familyId) return null;
    if (!store.isCurrentScope(this._sessionScope)) return null;
    if (op.scope.familyId !== this._sessionScope.familyId) return null;
    const fid = op.scope.familyId;
    this.clearShare();
    this.setData({ busy: true, ready: false, members: [], isOwner: false, errorText: "", noFamily: false });
    try {
      const data = await guard.run<{ members: Member[] }>(op, (hooks) =>
        request<{ members: Member[] }>({
          path: `/families/${fid}/members`,
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      const family = store.currentFamily();
      const list = Array.isArray(data.members) ? data.members : null;
      const me = list ? list.find((m) => m.user_id === store.user?.id) : null;
      if (!list || !me) {
        try { await refreshMe(); } catch (_) {}
        if (guard.scopeChanged(op)) { this.clearForScopeChange(); return null; }
        if (!guard.isCurrent(op)) return null;
        this._sessionScope = null;
        this.clearShare();
        this.setData({ familyName: "", members: [], isOwner: false, ready: false, busy: false, currentUserId: 0, errorText: "成员信息已变化，请重试" });
        return null;
      }
      this.setData({
        familyName: family ? family.name : "选择家庭",
        isOwner: family ? family.role === "owner" && me.role === "owner" : false,
        members: list,
        busy: false,
        ready: true,
        errorText: "",
      });
      return op;
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return null;
      }
      if (!guard.isCurrent(op)) return null;
      if (err instanceof ApiError && err.statusCode === 403) {
        try { await refreshMe(); } catch (_) {}
        if (guard.scopeChanged(op)) { this.clearForScopeChange(); return null; }
        if (!guard.isCurrent(op)) return null;
      }
      const message = err instanceof ApiError ? err.message : "加载失败，请重试";
      this.setData({ busy: false, ready: false, members: [], isOwner: false, errorText: message });
      return null;
    }
  },

  onRename() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._sessionScope!.familyId;
    let fired = false;
    wx.showModal({
      title: "修改家庭组名称",
      editable: true,
      placeholderText: this.data.familyName,
      success: async (res) => {
        const name = (res.content || "").trim();
        if (!res.confirm || fired || !name || name.length > 64) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
        fired = true;
        g.invalidate();
        const wop = g.capture();
        if (!g.isCurrent(wop)) return;
        this.setData({ busy: true });
        this.clearShare();
        try {
          await g.run(wop, (hooks) =>
            request({ path: `/families/${fid}`, method: "POST", data: { name }, isCancelled: hooks.isCancelled, onTask: hooks.onTask })
          );
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop) || !store.user || store.user.id !== uid) return;
          await refreshMe();
          if (!g.isFrameCurrent(wop.generation)) return;
          if (!store.user || store.user.id !== uid) {
            this.clearForScopeChange();
            return;
          }
          const newScope = store.captureScope();
          if (newScope.familyId !== fid) {
            this.clearForScopeChange();
            return;
          }
          const fop = g.capture();
          this._sessionScope = newScope;
          if (!g.isCurrent(fop)) return;
          await this.loadMembers(fop);
          if (!g.isCurrent(fop)) return;
          wx.showToast({ title: "已修改", icon: "none" });
        } catch (err) {
          if (!g.isFrameCurrent(wop.generation)) return;
          this.setData({ busy: false });
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop)) return;
          const message = err instanceof ApiError ? err.message : "修改失败，请重试";
          this.setData({ errorText: message });
        }
      },
    });
  },
  async onInvite() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard as PageScope;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return;
    const fid = this._sessionScope!.familyId;
    this.setData({ busy: true });
    this.clearShare();
    try {
      const data = await guard.run<{ invite_token: string; share_path: string; expires_at: string }>(op, (hooks) =>
        request<{ invite_token: string; share_path: string; expires_at: string }>({
          path: `/families/${fid}/invite`, method: "POST",
          isCancelled: hooks.isCancelled, onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) { this.clearForScopeChange(); return; }
      if (!guard.isCurrent(op)) return;
      const exp = Date.parse(data.expires_at);
      if (
        typeof data.invite_token === "string" &&
        data.invite_token &&
        data.share_path === `pages/family-join/index?invite_token=${encodeURIComponent(data.invite_token)}` &&
        Number.isFinite(exp) && exp > Date.now()
      ) {
        this._share = { scope: op.scope, path: data.share_path, expiresAt: exp };
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        wx.showToast({ title: "请点击右上角转发给家人", icon: "none", duration: 2500 });
      } else {
        this.setData({ errorText: "邀请生成失败" });
      }
      this.setData({ busy: false });
    } catch (err) {
      if (!guard.isFrameCurrent(op.generation)) return;
      this.setData({ busy: false });
      if (guard.scopeChanged(op)) { this.clearForScopeChange(); return; }
      if (!guard.isCurrent(op)) return;
      const message = err instanceof ApiError ? err.message : "邀请失败，请重试";
      this.setData({ errorText: message });
    }
  },
  onShareAppMessage() {
    const guard = this._guard as PageScope;
    const s = this._share;
    const ok =
      guard && guard.isFrameCurrent(guard.frame()) &&
      this.data.ready && !this.data.busy && this.data.isOwner &&
      s && store.isCurrentScope(s.scope) && s.expiresAt > Date.now();
    if (!ok) {
      return { title: "唔叽", path: "/pages/launch/index" };
    }
    return {
      title: `邀请你加入家庭组「${this.data.familyName}」`,
      path: `/${s!.path}`,
    };
  },
  onRemoveMember(e: WechatMiniprogram.TouchEvent) {
    if (!this.active() || !this.data.isOwner) return;
    const id = Number((e.currentTarget.dataset as any).id);
    const member = this.data.members.find((m) => m.user_id === id);
    if (!member || member.role === "owner" || member.user_id === store.user?.id) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._sessionScope!.familyId;
    let fired = false;
    wx.showModal({
      title: "移除成员",
      content: `确定将「${member.nickname || "该成员"}」移出家庭组？`,
      success: async (res) => {
        if (!res.confirm || fired) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
        fired = true;
        g.invalidate();
        const wop = g.capture();
        if (!g.isCurrent(wop)) return;
        this.setData({ busy: true });
        this.clearShare();
        try {
          await g.run(wop, (hooks) =>
            request({ path: `/families/${fid}/members/${member.user_id}`, method: "DELETE", isCancelled: hooks.isCancelled, onTask: hooks.onTask })
          );
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop) || !store.user || store.user.id !== uid) return;
          await refreshMe();
          if (!g.isFrameCurrent(wop.generation)) return;
          if (!store.user || store.user.id !== uid) {
            this.clearForScopeChange();
            return;
          }
          const newScope = store.captureScope();
          if (newScope.familyId !== fid) {
            this.clearForScopeChange();
            return;
          }
          const fop = g.capture();
          this._sessionScope = newScope;
          if (!g.isCurrent(fop)) return;
          await this.loadMembers(fop);
          if (!g.isCurrent(fop)) return;
          wx.showToast({ title: "已移除", icon: "none" });
        } catch (err) {
          if (!g.isFrameCurrent(wop.generation)) return;
          this.setData({ busy: false });
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop)) return;
          const message = err instanceof ApiError ? err.message : "移除失败，请重试";
          this.setData({ errorText: message });
        }
      },
    });
  },
  onTransfer(e: WechatMiniprogram.TouchEvent) {
    if (!this.active() || !this.data.isOwner) return;
    const id = Number((e.currentTarget.dataset as any).id);
    const member = this.data.members.find((m) => m.user_id === id);
    if (!member || member.role === "owner" || member.user_id === store.user?.id) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._sessionScope!.familyId;
    let fired = false;
    wx.showModal({
      title: "转让家庭组",
      content: `将「${this.data.familyName}」转让给「${member.nickname || "该成员"}」？你将成为普通成员。`,
      success: async (res) => {
        if (!res.confirm || fired) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
        fired = true;
        g.invalidate();
        const wop = g.capture();
        if (!g.isCurrent(wop)) return;
        this.setData({ busy: true });
        this.clearShare();
        try {
          await g.run(wop, (hooks) =>
            request({ path: `/families/${fid}/transfer`, method: "POST", data: { user_id: member.user_id }, isCancelled: hooks.isCancelled, onTask: hooks.onTask })
          );
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop) || !store.user || store.user.id !== uid) return;
          await refreshMe();
          if (!g.isFrameCurrent(wop.generation)) return;
          if (!store.user || store.user.id !== uid) {
            this.clearForScopeChange();
            return;
          }
          const newScope = store.captureScope();
          if (newScope.familyId !== fid) {
            this.clearForScopeChange();
            return;
          }
          const fop = g.capture();
          this._sessionScope = newScope;
          if (!g.isCurrent(fop)) return;
          await this.loadMembers(fop);
          if (!g.isCurrent(fop)) return;
          wx.showToast({ title: "已转让", icon: "none" });
        } catch (err) {
          if (!g.isFrameCurrent(wop.generation)) return;
          this.setData({ busy: false });
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop)) return;
          const message = err instanceof ApiError ? err.message : "转让失败，请重试";
          this.setData({ errorText: message });
        }
      },
    });
  },
  onDissolve() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._sessionScope!.familyId;
    const familyName = this.data.familyName;
    let fired = false;
    wx.showModal({
      title: "解散家庭组",
      editable: true,
      placeholderText: `请输入「${familyName}」确认`,
      success: async (res) => {
        if (!res.confirm || fired || (res.content || "").trim() !== familyName) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
        fired = true;
        g.invalidate();
        const wop = g.capture();
        if (!g.isCurrent(wop)) return;
        this.setData({ busy: true });
        this.clearShare();
        try {
          await g.run(wop, (hooks) =>
            request({ path: `/families/${fid}`, method: "DELETE", isCancelled: hooks.isCancelled, onTask: hooks.onTask })
          );
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop) || !store.user || store.user.id !== uid) return;
          await refreshMe();
          if (!g.isFrameCurrent(wop.generation)) return;
          if (!store.user || store.user.id !== uid) {
            this.clearForScopeChange();
            return;
          }
          if (store.families.some((f) => f.id === fid)) {
            this.clearForScopeChange();
            this.setData({ errorText: "解散未确认，请刷新查看" });
            return;
          }
          const fop = g.capture();
          this._sessionScope = store.captureScope();
          this.setData({ familyName: "", members: [], isOwner: false, busy: false, ready: false, noFamily: !store.currentFamilyId });
          if (!g.isCurrent(fop)) return;
          wx.showToast({ title: "已解散", icon: "none" });
          const pages = getCurrentPages ? getCurrentPages() : [];
          if (pages.length > 1) {
            wx.navigateBack();
          } else {
            wx.switchTab({ url: "/pages/profile/index" });
          }
        } catch (err) {
          if (!g.isFrameCurrent(wop.generation)) return;
          this.setData({ busy: false });
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop)) return;
          const message = err instanceof ApiError ? err.message : "解散失败，请重试";
          this.setData({ errorText: message });
        }
      },
    });
  },
  onLeave() {
    if (!this.active()) return;
    if (this.data.isOwner) {
      wx.showToast({ title: "所有者需先转让或解散家庭组", icon: "none" });
      return;
    }
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._sessionScope!.familyId;
    let fired = false;
    wx.showModal({
      title: "退出家庭组",
      content: "退出后将无法查看该家庭组的物品记录。",
      success: async (res) => {
        if (!res.confirm || fired) return;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
        fired = true;
        g.invalidate();
        const wop = g.capture();
        if (!g.isCurrent(wop)) return;
        this.setData({ busy: true });
        try {
          await g.run(wop, (hooks) =>
            request({ path: `/families/${fid}/members/${uid}`, method: "DELETE", isCancelled: hooks.isCancelled, onTask: hooks.onTask })
          );
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop) || !store.user || store.user.id !== uid) return;
          await refreshMe();
          if (!g.isFrameCurrent(wop.generation)) return;
          if (!store.user || store.user.id !== uid) {
            this.clearForScopeChange();
            return;
          }
          if (store.families.some((f) => f.id === fid)) {
            this.clearForScopeChange();
            this.setData({ errorText: "退出未确认，请刷新查看" });
            return;
          }
          const fop = g.capture();
          this._sessionScope = store.captureScope();
          this.clearShare();
          this.setData({ familyName: "", members: [], isOwner: false, busy: false, ready: false, noFamily: !store.currentFamilyId });
          if (!g.isCurrent(fop)) return;
          const pages = getCurrentPages ? getCurrentPages() : [];
          if (pages.length > 1) {
            wx.navigateBack();
          } else {
            wx.switchTab({ url: "/pages/profile/index" });
          }
        } catch (err) {
          if (!g.isFrameCurrent(wop.generation)) return;
          this.setData({ busy: false });
          if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
          if (!g.isCurrent(wop)) return;
          const message = err instanceof ApiError ? err.message : "退出失败，请重试";
          this.setData({ errorText: message });
        }
      },
    });
  },
  onRetryTap() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy) return;
    this.activate();
  },
  goList() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy) return;
    if (!store.user || !store.user.id) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    wx.navigateTo({ url: "/pages/family-list/index" });
  },
});
