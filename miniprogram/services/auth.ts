/** 登录：wx.login 换取应用令牌，首次登录后端自动创建“我的家”（文档 7.1）。 */
import { request, setToken, getToken } from "./api";
import { store, FamilyInfo, UserInfo } from "../store/index";

interface LoginData {
  access_token: string;
  user: UserInfo;
  current_family_id: number;
}

interface MeData {
  user: UserInfo;
  families: FamilyInfo[];
}

export function wxLogin(): Promise<LoginData> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: async (res) => {
        if (!res.code) {
          reject(new Error("微信登录失败"));
          return;
        }
        try {
          const data = await request<LoginData>({
            path: "/auth/wechat-login",
            method: "POST",
            data: { code: res.code },
          });
          setToken(data.access_token);
          store.setUser(data.user);
          resolve(data);
        } catch (err) {
          reject(err);
        }
      },
      fail: () => reject(new Error("微信登录失败")),
    });
  });
}

/** 拉取当前用户与家庭组列表并写入全局状态。 */
export async function refreshMe(): Promise<MeData> {
  const data = await request<MeData>({ path: "/me" });
  store.setUser(data.user);
  store.setFamilies(data.families);
  return data;
}

/** 确保已登录：有令牌则校验，无令牌或失效则重新登录。 */
export async function ensureLogin(): Promise<void> {
  store.restore();
  if (getToken()) {
    try {
      await refreshMe();
      return;
    } catch (_) {
      // 令牌失效，走重新登录
    }
  }
  const login = await wxLogin();
  if (!store.currentFamilyId) {
    store.setCurrentFamily(login.current_family_id);
  }
  await refreshMe();
}
