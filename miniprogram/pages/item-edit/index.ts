/** P07 修改物品：名称、位置必填，照片可重拍，记录文字只读（文档 6.3）。 */
import { request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { uploadImage } from "../../services/upload";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

const NAV_DELAY_MS = 600;

Page({
  data: {
    name: "",
    locationText: "",
    recordText: "",
    imageUrl: "",
    newPhotoPath: "",
    saving: false,
    saved: false,
    needsRefresh: false,
    loaded: false,
    ready: false,
    busy: false,
    blocked: false,
    noFamily: false,
    errorText: "",
  },
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _loaded: null as { scope: Scope; itemId: number; version: number } | null,
  _boundFamilyId: 0,
  _boundUserId: 0,
  _invalidRoute: false,
  _cachedToken: null as { path: string; familyId: number; token: string } | null,
  _id: 0,
  _navTimer: null as any,
  _authFailed: false,
  _draft: null as { scope: Scope; fields: { name: string; locationText: string; recordText: string; imageUrl: string; newPhotoPath: string } } | null,
  _write: null as { op: ScopeOperation; sent: boolean } | null,
  _refreshMessage: "",

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
      this.setData({ errorText: "参数错误", blocked: true });
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
    if (this._loaded && this.data.loaded && this.data.ready) {
      this._draft = {
        scope: this._loaded.scope,
        fields: {
          name: this.data.name, locationText: this.data.locationText,
          recordText: this.data.recordText, imageUrl: this.data.imageUrl,
          newPhotoPath: this.data.newPhotoPath,
        },
      };
    }
    guard.invalidate();
    const frame = guard.frame();
    const needsRefresh = this.data.needsRefresh || !!(this._write && this._write.sent && !this.data.saved);
    if (needsRefresh && !this._refreshMessage) this._refreshMessage = "保存结果未确认，请刷新查看后再修改";
    this.setData({
      busy: true, ready: false, loaded: false, saving: false, errorText: "",
      name: "", locationText: "", recordText: "", imageUrl: "", newPhotoPath: "",
      blocked: false, noFamily: false, needsRefresh,
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
      this._loaded = null;
      this._draft = null;
      this._cachedToken = null;
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
      this._loaded = null;
      this._draft = null;
      this._cachedToken = null;
      this.setData({ busy: false, noFamily: true, errorText: "还没有家庭，请先创建或加入" });
      return;
    }
    if (!this._boundFamilyId) this._boundFamilyId = scope.familyId;
    if (this._boundFamilyId !== scope.familyId || (this._draft && !store.isCurrentScope(this._draft.scope))) {
      this.clearForScopeChange();
      return;
    }
    if (this._draft && this._loaded && store.isCurrentScope(this._loaded.scope)) {
      this.setData({
        ...this._draft.fields, busy: false, ready: true, loaded: true,
        errorText: needsRefresh ? this._refreshMessage : "",
      });
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
    this._cachedToken = null;
    this._draft = null;
    this._write = null;
    this._refreshMessage = "";
    this.setData({
      name: "", locationText: "", recordText: "", imageUrl: "", newPhotoPath: "",
      ready: false, busy: false, saving: false, loaded: false,
      saved: false, needsRefresh: false, blocked: true, noFamily: false,
      errorText: "状态已变化，请返回列表重新选择",
    });
  },
  async loadItem(): Promise<ScopeOperation | null> {
    const guard = this._guard as PageScope;
    if (!this._id || this._invalidRoute || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) return null;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.saving || this.data.saved) return null;
    if (this._boundFamilyId !== this._sessionScope.familyId || this._boundUserId !== this._sessionScope.userId) return null;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op) || this._boundFamilyId !== op.scope.familyId) return null;
    const fid = this._boundFamilyId;
    this._loaded = null;
    this._draft = null;
    this._cachedToken = null;
    this.setData({
      busy: true, ready: false, loaded: false, errorText: "",
      name: "", locationText: "", recordText: "", imageUrl: "", newPhotoPath: "",
    });
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
        name: item.name,
        locationText: item.location_text,
        recordText: item.record_text,
        imageUrl: item.image_url,
        loaded: true,
        busy: false,
        ready: true,
        needsRefresh: false,
        newPhotoPath: "",
      });
      this._cachedToken = null;
      this._write = null;
      this._refreshMessage = "";
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
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || this.data.saving || this.data.saved) return;
    if (!this._id || this._invalidRoute || this.data.blocked || this.data.noFamily) return;
    if (this._authFailed || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) {
      this.activate();
      return;
     }
    if (this._write && !this._write.sent && this._loaded && this.data.ready && !this.data.needsRefresh) {
      this.onSave();
      return;
    }
    this.loadItem();
  },
  onNameInput(e: WechatMiniprogram.Input) {
    if (!this.active() || this.data.saving || this.data.needsRefresh || this.data.saved) return;
    this.setData({ name: e.detail.value });
  },
  onLocationInput(e: WechatMiniprogram.Input) {
    if (!this.active() || this.data.saving || this.data.needsRefresh || this.data.saved) return;
    this.setData({ locationText: e.detail.value });
  },
  retakePhoto() {
    if (!this.active() || this.data.saving || this.data.needsRefresh || this.data.saved) return;
    const guard = this._guard as PageScope;
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: (res) => {
        const g = this._guard as PageScope;
        if (!g.isCurrent(op) || !store.user || store.user.id !== uid || this.data.saving || this.data.saved || this.data.needsRefresh) return;
        if (!res.tempFiles || !res.tempFiles.length || !res.tempFiles[0].tempFilePath) return;
        this.setData({ newPhotoPath: res.tempFiles[0].tempFilePath });
        this._cachedToken = null;
      },
    });
  },
  async onSave() {
    const guard = this._guard as PageScope;
    if (!this.active() || this.data.saving || this.data.needsRefresh || this.data.saved) return;
    const name = this.data.name.trim();
    const location = this.data.locationText.trim();
    if (!name || name.length > 128) {
      wx.showToast({ title: "名称需为 1～128 个字符", icon: "none" });
      return;
    }
    if (!location || location.length > 255) {
      wx.showToast({ title: "位置需为 1～255 个字符", icon: "none" });
      return;
    }
    guard.invalidate();
    const op = guard.capture();
    const uid = this._sessionScope!.userId;
    const fid = this._boundFamilyId;
    const version = this._loaded!.version;
    const photoPath = this.data.newPhotoPath;
    const cached = this._cachedToken;
    this.setData({ saving: true, busy: true, errorText: "" });
    const write = { op, sent: false };
    this._write = write;
    try {
      let imageToken: string | null = null;
      if (cached && cached.path === photoPath && cached.familyId === fid) {
        imageToken = cached.token;
      } else if (photoPath) {
        const upload = await guard.run<{ image_token: string }>(op, (hooks) =>
          uploadImage(fid, photoPath, {
            isCancelled: hooks.isCancelled,
            onTask: hooks.onTask,
          })
        );
        if (guard.scopeChanged(op)) {
          this.clearForScopeChange();
          return;
        }
        if (!guard.isCurrent(op) || !store.user || store.user.id !== uid) return;
        imageToken = upload.image_token;
        this._cachedToken = { path: photoPath, familyId: fid, token: upload.image_token };
      }
      write.sent = true;
      await guard.run(op, (hooks) =>
        request({
          path: `/items/${this._id}?family_id=${fid}`,
          method: "POST",
          data: {
            name,
            location_text: location,
            image_token: imageToken,
            expected_version: version,
          },
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        })
      );
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op) || !store.user || store.user.id !== uid) return;
      this._write = null;
      this._draft = null;
      this.setData({ saved: true, saving: false, busy: false });
      wx.showToast({ title: "已保存", icon: "none" });
      const timer = setTimeout(() => {
        if (this._navTimer !== timer) return;
        this._navTimer = null;
        const g = this._guard as PageScope;
        if (!g.isCurrent(op)) return;
        const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        if (pages.length > 1) wx.navigateBack();
        else wx.switchTab({ url: "/pages/items/index" });
      }, NAV_DELAY_MS);
      this._navTimer = timer;
    } catch (err) {
      if (guard.scopeChanged(op)) {
        this.clearForScopeChange();
        return;
      }
      if (!guard.isCurrent(op)) return;
      if (err instanceof ApiError && err.statusCode === 409) {
        write.sent = false;
        this._refreshMessage = "家人已修改，请刷新后重新编辑";
        this.setData({ saving: false, busy: false, needsRefresh: true, errorText: "家人已修改，请刷新后重新编辑" });
        return;
      }
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
      if (write.sent) {
        this._refreshMessage = "保存结果未确认，请刷新查看后再修改";
        this.setData({ saving: false, busy: false, needsRefresh: true, errorText: this._refreshMessage });
        return;
      }
      const message = err instanceof ApiError ? err.message : "保存失败，请重试";
      this.setData({ saving: false, busy: false, errorText: message });
    }
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
