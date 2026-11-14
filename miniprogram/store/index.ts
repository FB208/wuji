/** 全局状态：当前用户与家庭组。客户端本地保存最近一次选择（文档 7.4）。 */

export interface FamilyInfo {
  id: number;
  name: string;
  owner_user_id: number;
  role: string;
  member_count?: number;
}

export interface UserInfo {
  id: number;
  nickname: string | null;
  avatar_url: string | null;
}

export interface Scope {
  version: number;
  userId: number;
  familyId: number;
}

const FAMILY_KEY = "wuji_current_family_id";

class Store {
  user: UserInfo | null = null;
  families: FamilyInfo[] = [];
  currentFamilyId = 0;
  scopeVersion = 0;
  private pendingFamilyId: number | null = null;

  private bump() {
    this.scopeVersion += 1;
  }

  captureScope(): Scope {
    return {
      version: this.scopeVersion,
      userId: this.user ? this.user.id : 0,
      familyId: this.currentFamilyId,
    };
  }

  isCurrentScope(scope: Scope): boolean {
    return (
      scope.version === this.scopeVersion &&
      scope.userId === (this.user ? this.user.id : 0) &&
      scope.familyId === this.currentFamilyId
    );
  }

  setUser(user: UserInfo) {
    const prev = this.user ? this.user.id : 0;
    this.user = user;
    if (user.id !== prev) {
      this.families = [];
      this.currentFamilyId = 0;
      this.pendingFamilyId = null;
      this.bump();
      try {
        wx.removeStorageSync(FAMILY_KEY);
      } catch (_) {}
    }
  }

  setFamilies(families: FamilyInfo[]) {
    this.families = families;
    if (!families.some((f) => f.id === this.currentFamilyId)) {
      this.applyCurrentFamily(families.length > 0 ? families[0].id : 0);
    }
  }

  private applyCurrentFamily(familyId: number) {
    if (familyId !== this.currentFamilyId) {
      this.currentFamilyId = familyId;
      this.bump();
    }
    try {
      wx.setStorageSync(FAMILY_KEY, familyId);
    } catch (_) {}
  }

  setCurrentFamily(familyId: number) {
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
      const saved = wx.getStorageSync<number>(FAMILY_KEY);
      this.pendingFamilyId = Number.isSafeInteger(saved) && saved > 0 ? saved : null;
    } catch (_) {
      this.pendingFamilyId = null;
    }
  }

  applyMe(user: UserInfo, families: FamilyInfo[], preferredFamilyId?: number) {
    const prevUserId = this.user ? this.user.id : 0;
    const sameIdentity = prevUserId === 0 || prevUserId === user.id;
    const currentFamilyId = sameIdentity ? this.currentFamilyId : 0;
    const pendingFamilyId = sameIdentity ? this.pendingFamilyId : null;
    this.user = user;
    this.families = families;
    if (user.id !== prevUserId) this.bump();
    const preferred =
      preferredFamilyId ??
      (pendingFamilyId !== null ? pendingFamilyId : currentFamilyId);
    if (families.some((f) => f.id === preferred)) {
      this.applyCurrentFamily(preferred as number);
    } else {
      this.applyCurrentFamily(families.length > 0 ? families[0].id : 0);
    }
    this.pendingFamilyId = null;
  }

  clearSession() {
    this.user = null;
    this.families = [];
    this.pendingFamilyId = null;
    if (this.currentFamilyId !== 0) {
      this.currentFamilyId = 0;
    }
    this.bump();
    try {
      wx.removeStorageSync(FAMILY_KEY);
    } catch (_) {}
  }

  currentFamily(): FamilyInfo | null {
    return this.families.find((f) => f.id === this.currentFamilyId) || null;
  }
}

export const store = new Store();
