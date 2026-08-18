/** HTTP 封装：统一响应结构、令牌、错误码处理（文档 13.1 / 13.6）。 */

export const API_BASE_URL = "https://api.example.com/api/v1"; // 部署后替换为正式域名

const TOKEN_KEY = "wuji_access_token";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export class ApiError extends Error {
  code: string;
  retryable: boolean;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

export function getToken(): string {
  return wx.getStorageSync<string>(TOKEN_KEY) || "";
}

export function setToken(token: string) {
  wx.setStorageSync(TOKEN_KEY, token);
}

export function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
}

function parseBody<T>(statusCode: number, body: any): T {
  if (statusCode >= 200 && statusCode < 300 && body && body.data !== undefined) {
    return body.data as T;
  }
  const err: ApiErrorBody =
    body && body.error
      ? body.error
      : { code: "NETWORK_ERROR", message: "网络异常，请重试。", retryable: true };
  throw new ApiError(err);
}

export function request<T>(options: {
  path: string;
  // wx.request 不支持 PATCH，更新类接口统一用 POST（后端同时接受 PATCH/POST）
  method?: "GET" | "POST" | "DELETE";
  data?: Record<string, any>;
  idempotencyKey?: string;
}): Promise<T> {
  const header: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) header["Authorization"] = `Bearer ${token}`;
  if (options.idempotencyKey) header["Idempotency-Key"] = options.idempotencyKey;

  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${options.path}`,
      method: options.method || "GET",
      data: options.data,
      header,
      success: (res) => {
        try {
          resolve(parseBody<T>(res.statusCode, res.data));
        } catch (err) {
          reject(err);
        }
      },
      fail: () =>
        reject(new ApiError({ code: "NETWORK_ERROR", message: "网络异常，请重试。", retryable: true })),
    });
  });
}

export function uploadFile<T>(options: {
  path: string;
  filePath: string;
  name: string;
  formData?: Record<string, any>;
}): Promise<T> {
  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header["Authorization"] = `Bearer ${token}`;

  return new Promise<T>((resolve, reject) => {
    wx.uploadFile({
      url: `${API_BASE_URL}${options.path}`,
      filePath: options.filePath,
      name: options.name,
      formData: options.formData,
      header,
      success: (res) => {
        try {
          const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
          resolve(parseBody<T>(res.statusCode, body));
        } catch (err) {
          reject(err);
        }
      },
      fail: () =>
        reject(new ApiError({ code: "NETWORK_ERROR", message: "网络异常，请重试。", retryable: true })),
    });
  });
}

export function newIdempotencyKey(): string {
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 统一错误提示；AUTH_REQUIRED 时跳回登录页。 */
export function showApiError(err: unknown, fallback = "网络异常，请重试。") {
  const message = err instanceof ApiError ? err.message : fallback;
  if (err instanceof ApiError && err.code === "AUTH_REQUIRED") {
    clearToken();
    wx.reLaunch({ url: "/pages/launch/index" });
    return;
  }
  wx.showToast({ title: message, icon: "none" });
}
