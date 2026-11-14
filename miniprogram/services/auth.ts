/** 登录：wx.login 换取应用令牌，首次登录后端自动创建“我的家”（文档 7.1）。 */
import { ApiError, clearToken, getToken, registerAuthRecovery, request, setToken } from "./api";
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

const BLOCKED_KEY = "wuji_login_blocked";

let meSeq = 0;
let loginSeq = 0;
let blockedInMemory = false;

export function blockAutoLogin() {
  blockedInMemory = true;
  loginSeq += 1;
  meSeq += 1;
  wx.setStorageSync(BLOCKED_KEY, true);
}

export function unblockAutoLogin() {
  wx.removeStorageSync(BLOCKED_KEY);
  blockedInMemory = false;
}

function isBlocked(): boolean {
  try {
    return blockedInMemory || !!wx.getStorageSync(BLOCKED_KEY);
  } catch (_) {
    return blockedInMemory;
  }
}

function authCancelled(): ApiError {
  return new ApiError({ code: "CANCELLED", message: "登录状态已变化，请重试", retryable: false });
}

function identityChanged(): ApiError {
  let lastErr: unknown = null;
  try {
    blockAutoLogin();
  } catch (e) {
    lastErr = e;
  }
  try {
    clearToken();
  } catch (e) {
    lastErr = e;
  }
  try {
    store.clearSession();
  } catch (e) {
    lastErr = e;
  }
  if (lastErr) throw lastErr;
  return new ApiError({ code: "LOGIN_BLOCKED", message: "登录身份已变化，请点击重新登录", retryable: false });
}

export function wxLogin(allowRegistration = false): Promise<LoginData> {
  const seq = ++loginSeq;
  const userId = store.user ? store.user.id : 0;
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
            data: { code: res.code, allow_registration: allowRegistration },
            skipAuthRecovery: true,
          });
          if (seq !== loginSeq || isBlocked() || userId !== (store.user ? store.user.id : 0)) {
            throw authCancelled();
          }
          if (
            !data ||
            !data.user ||
            !Number.isSafeInteger(data.user.id) || data.user.id <= 0 ||
            typeof data.access_token !== "string" || !data.access_token.trim()
          ) {
            throw new ApiError({ code: "INVALID_RESPONSE", message: "响应格式异常", retryable: true });
          }
          if (userId !== 0 && data.user.id !== userId) {
            if (!allowRegistration) {
              throw identityChanged();
            }
            clearToken();
            store.clearSession();
          }
          setToken(data.access_token);
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
export async function refreshMe(skipAuthRecovery = false, preferredFamilyId?: number): Promise<MeData> {
  const seq = ++meSeq;
  const epoch = store.user ? store.user.id : 0;
  const token = getToken();
  const scope = store.captureScope();
  const data = await request<MeData>({ path: "/me", skipAuthRecovery });
  if (seq !== meSeq || token !== getToken() || epoch !== (store.user ? store.user.id : 0)) {
    throw authCancelled();
  }
  if (
    !data ||
    !data.user ||
    !Number.isSafeInteger(data.user.id) || data.user.id <= 0 ||
    !Array.isArray(data.families)
  ) {
    throw new ApiError({ code: "INVALID_RESPONSE", message: "响应格式异常", retryable: true });
  }
  if (epoch !== 0 && data.user.id !== epoch) {
    throw identityChanged();
  }
  store.applyMe(
    data.user,
    data.families,
    store.isCurrentScope(scope) ? preferredFamilyId : undefined
  );
  return data;
}

export async function refreshCredentials(): Promise<boolean> {
  if (isBlocked()) return false;
  const prevUserId = store.user ? store.user.id : 0;
  if (!prevUserId) return false;
  try {
    const login = await wxLogin(false);
    const me = await refreshMe(true);
    if (getToken() !== login.access_token || (store.user ? store.user.id : 0) !== prevUserId) return false;
    if (me.user.id !== prevUserId) return false;
    return true;
  } catch (_) {
    return false;
  }
}

export function installAuthRecovery() {
  registerAuthRecovery(refreshCredentials);
}

/** 确保已登录：有令牌则校验，无令牌或失效则重新登录。 */
export async function ensureLogin(options: { interactive?: boolean } = {}): Promise<void> {
  if (options.interactive) unblockAutoLogin();
  store.restore();
  if (isBlocked()) {
    throw new ApiError({ code: "LOGIN_BLOCKED", message: "请点击重新登录", retryable: false });
  }
  const hadToken = !!getToken();
  if (hadToken) {
    try {
      await refreshMe(true);
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || (err.code !== "AUTH_REQUIRED" && err.statusCode !== 401)) {
        throw err;
      }
      // 令牌失效，走重新登录
    }
  }
  const login = await wxLogin(!!options.interactive || (!hadToken && !store.user));
  const me = await refreshMe(true);
  if (
    getToken() !== login.access_token ||
    me.user.id !== login.user.id ||
    !store.user ||
    store.user.id !== me.user.id
  ) {
    throw authCancelled();
  }
}
