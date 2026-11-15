/** P09 家庭组管理：改名、邀请、成员管理、退出（文档 7.2 / 7.3）。 */
const { request, ApiError } = require("../../services/api");
const { ensureLogin, refreshMe } = require("../../services/auth");
const { PageScope } = require("../../services/page-scope");
const { store } = require("../../store/index");
const { bindNotice, registerNotice, showNotice, confirmNotice, promptNotice } = require("../../services/notice");

Page({
  data: {
    notice: null,
    familyName: "",
    isOwner: false,
    members: [],
    ready: false,
    busy: false,
    noFamily: false,
    currentUserId: 0,
    errorText: "",
  },
  _guard: null,
  _sessionScope: null,
  _share: null,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    registerNotice(bindNotice(this));
    const guard = this._guard;
    guard.show();
    this.activate();
  },
  async activate() {
    const guard = this._guard;
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
    registerNotice(null);
    this.clearShare();
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
    const guard = this._guard;
    guard.invalidate();
    this.clearShare();
    this._sessionScope = null;
    this.setData({
      familyName: "", members: [], isOwner: false,
      ready: false, busy: false, noFamily: false, currentUserId: 0,
      errorText: "状态已变化，请重试",
    });
  },
  async loadMembers(op) {
    const guard = this._guard;
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
      const data = await guard.run(op, (hooks) =>
        request({
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

  async onRename() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const name = ((await promptNotice({ title: "修改家庭组名称", placeholderText: this.data.familyName })) || "").trim();
    const g = this._guard;
    if (!name || name.length > 64 || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
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
      showNotice("已修改");
    } catch (err) {
      if (!g.isFrameCurrent(wop.generation)) return;
      this.setData({ busy: false });
      if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
      if (!g.isCurrent(wop)) return;
      const message = err instanceof ApiError ? err.message : "修改失败，请重试";
      this.setData({ errorText: message });
    }
  },
  async onInvite() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op)) return;
    const fid = this._sessionScope.familyId;
    this.setData({ busy: true });
    this.clearShare();
    try {
      const data = await guard.run(op, (hooks) =>
        request({
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
        showNotice({ text: "请点击右上角转发给家人", secondaryText: "邀请链接已准备好" });
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
    const guard = this._guard;
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
      path: `/${s.path}`,
    };
  },
  async onRemoveMember(e) {
    if (!this.active() || !this.data.isOwner) return;
    const id = Number(e.currentTarget.dataset.id);
    const member = this.data.members.find((m) => m.user_id === id);
    if (!member || member.role === "owner" || member.user_id === store.user?.id) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const ok = await confirmNotice({ title: "移除成员", text: `确定将「${member.nickname || "该成员"}」移出家庭组？`, confirmText: "移除" });
    const g = this._guard;
    if (!ok || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
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
      showNotice("已移除");
    } catch (err) {
      if (!g.isFrameCurrent(wop.generation)) return;
      this.setData({ busy: false });
      if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
      if (!g.isCurrent(wop)) return;
      const message = err instanceof ApiError ? err.message : "移除失败，请重试";
      this.setData({ errorText: message });
    }
  },
  async onTransfer(e) {
    if (!this.active() || !this.data.isOwner) return;
    const id = Number(e.currentTarget.dataset.id);
    const member = this.data.members.find((m) => m.user_id === id);
    if (!member || member.role === "owner" || member.user_id === store.user?.id) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const ok = await confirmNotice({ title: "转让家庭组", text: `将「${this.data.familyName}」转让给「${member.nickname || "该成员"}」？你将成为普通成员。`, confirmText: "转让" });
    const g = this._guard;
    if (!ok || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
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
      showNotice("已转让");
    } catch (err) {
      if (!g.isFrameCurrent(wop.generation)) return;
      this.setData({ busy: false });
      if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
      if (!g.isCurrent(wop)) return;
      const message = err instanceof ApiError ? err.message : "转让失败，请重试";
      this.setData({ errorText: message });
    }
  },
  async onDissolve() {
    if (!this.active() || !this.data.isOwner) return;
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const familyName = this.data.familyName;
    const input = await promptNotice({ title: "解散家庭组", text: "解散后所有成员将无法访问该家庭组。", placeholderText: `请输入「${familyName}」确认`, confirmText: "解散" });
    const g = this._guard;
    if (input === null || (input || "").trim() !== familyName || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
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
      showNotice("已解散", () => {
        const pages = getCurrentPages ? getCurrentPages() : [];
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.switchTab({ url: "/pages/profile/index" });
        }
      });
    } catch (err) {
      if (!g.isFrameCurrent(wop.generation)) return;
      this.setData({ busy: false });
      if (g.scopeChanged(wop)) { this.clearForScopeChange(); return; }
      if (!g.isCurrent(wop)) return;
      const message = err instanceof ApiError ? err.message : "解散失败，请重试";
      this.setData({ errorText: message });
    }
  },
  async onLeave() {
    if (!this.active()) return;
    if (this.data.isOwner) {
      showNotice("所有者需先转让或解散家庭组");
      return;
    }
    const guard = this._guard;
    const op = guard.capture();
    const uid = this._sessionScope.userId;
    const fid = this._sessionScope.familyId;
    const ok = await confirmNotice({ title: "退出家庭组", text: "退出后将无法查看该家庭组的物品记录。", confirmText: "退出" });
    const g = this._guard;
    if (!ok || !g.isCurrent(op) || this.data.busy || !store.user || store.user.id !== uid) return;
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
  onRetryTap() {
    const guard = this._guard;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy) return;
    this.activate();
  },
  goList() {
    const guard = this._guard;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy) return;
    if (!store.user || !store.user.id) {
      wx.reLaunch({ url: "/pages/launch/index" });
      return;
    }
    wx.navigateTo({ url: "/pages/family-list/index" });
  },
});
