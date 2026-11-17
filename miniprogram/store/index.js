/** 全局状态：当前用户与家庭组。客户端本地保存最近一次选择（文档 7.4）。 */

const FAMILY_KEY = "wuji_current_family_id";

class Store {
  user = null;
  families = [];
  currentFamilyId = 0;
  scopeVersion = 0;
  pendingFamilyId = null;
  initializedUserId = 0;

  bump() {
    this.scopeVersion += 1;
  }

  captureScope() {
    return {
      version: this.scopeVersion,
      userId: this.user ? this.user.id : 0,
      familyId: this.currentFamilyId,
    };
  }

  isCurrentScope(scope) {
    return (
      scope.version === this.scopeVersion &&
      scope.userId === (this.user ? this.user.id : 0) &&
      scope.familyId === this.currentFamilyId
    );
  }

  setUser(user) {
    const prev = this.user ? this.user.id : 0;
    this.user = user;
    if (user.id !== prev) {
      this.initializedUserId = 0;
      this.families = [];
      this.currentFamilyId = 0;
      this.pendingFamilyId = null;
      this.bump();
      try {
        wx.removeStorageSync(FAMILY_KEY);
      } catch (_) {}
    }
  }

  setFamilies(families) {
    this.families = families;
    if (!families.some((f) => f.id === this.currentFamilyId)) {
      this.applyCurrentFamily(families.length > 0 ? families[0].id : 0);
    }
  }

  applyCurrentFamily(familyId) {
    if (familyId !== this.currentFamilyId) {
      this.currentFamilyId = familyId;
      this.bump();
    }
    try {
      wx.setStorageSync(FAMILY_KEY, familyId);
    } catch (_) {}
  }

  setCurrentFamily(familyId) {
    if (familyId === 0) {
      if (this.families.length === 0) {
        this.pendingFamilyId = null;
        this.applyCurrentFamily(0);
      }
      return;
    }
    if (this.families.some((f) => f.id === familyId)) {
      this.pendingFamilyId = null;
      this.applyCurrentFamily(familyId);
    }
  }

  restore() {
    try {
      const saved = wx.getStorageSync(FAMILY_KEY);
      this.pendingFamilyId = Number.isSafeInteger(saved) && saved > 0 ? saved : null;
    } catch (_) {
      this.pendingFamilyId = null;
    }
  }

  applyMe(user, families, preferredFamilyId) {
    const prevUserId = this.user ? this.user.id : 0;
    const sameIdentity = prevUserId === 0 || prevUserId === user.id;
    const currentFamilyId = sameIdentity ? this.currentFamilyId : 0;
    const pendingFamilyId = sameIdentity ? this.pendingFamilyId : null;
    // 默认家庭仅在账号本次运行首次初始化时应用，刷新资料不覆盖手动切换。
    const startupDefault =
      this.initializedUserId !== user.id && families.some((f) => f.id === user.default_family_id)
        ? user.default_family_id
        : null;
    this.user = user;
    this.families = families;
    if (user.id !== prevUserId) this.bump();
    const preferred =
      preferredFamilyId ??
      startupDefault ??
      (pendingFamilyId !== null ? pendingFamilyId : currentFamilyId);
    if (families.some((f) => f.id === preferred)) {
      this.applyCurrentFamily(preferred);
    } else {
      this.applyCurrentFamily(families.length > 0 ? families[0].id : 0);
    }
    this.pendingFamilyId = null;
    this.initializedUserId = user.id;
  }

  clearSession() {
    this.user = null;
    this.families = [];
    this.pendingFamilyId = null;
    this.initializedUserId = 0;
    if (this.currentFamilyId !== 0) {
      this.currentFamilyId = 0;
    }
    this.bump();
    try {
      wx.removeStorageSync(FAMILY_KEY);
    } catch (_) {}
  }

  currentFamily() {
    return this.families.find((f) => f.id === this.currentFamilyId) || null;
  }
}

const store = new Store();

module.exports = { store };
