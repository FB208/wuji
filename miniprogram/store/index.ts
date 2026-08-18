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

const FAMILY_KEY = "wuji_current_family_id";

class Store {
  user: UserInfo | null = null;
  families: FamilyInfo[] = [];
  currentFamilyId = 0;

  setUser(user: UserInfo) {
    this.user = user;
  }

  setFamilies(families: FamilyInfo[]) {
    this.families = families;
    if (!families.some((f) => f.id === this.currentFamilyId)) {
      this.setCurrentFamily(families.length > 0 ? families[0].id : 0);
    }
  }

  setCurrentFamily(familyId: number) {
    this.currentFamilyId = familyId;
    wx.setStorageSync(FAMILY_KEY, familyId);
  }

  restore() {
    const saved = wx.getStorageSync<number>(FAMILY_KEY);
    if (saved) {
      this.currentFamilyId = saved;
    }
  }

  currentFamily(): FamilyInfo | null {
    return this.families.find((f) => f.id === this.currentFamilyId) || null;
  }
}

export const store = new Store();
