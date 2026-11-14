/** HTTP 封装：统一响应结构、令牌、错误码处理（文档 13.1 / 13.6）。 */
import { showNotice } from "./notice";

export const API_BASE_URL = "http://192.168.13.196:8000/api/v1"; // 部署后替换为正式域名

const TOKEN_KEY = "wuji_access_token";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  statusCode: number;
  retryAfterMs: number;

  constructor(body: ApiErrorBody, statusCode = 0, retryAfterMs = 0) {
    super(body.message);
    this.code = body.code;
    this.retryable = body.retryable;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
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

export function newIdempotencyKey(): string {
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export type RecoveryFn = () => Promise<boolean>;
let recoveryFn: RecoveryFn | null = null;
let recoveryInflight: Promise<boolean> | null = null;

export function registerAuthRecovery(fn: RecoveryFn) {
  recoveryFn = fn;
}

function recoverOnce(): Promise<boolean> {
  if (!recoveryFn) return Promise.resolve(false);
  if (!recoveryInflight) {
    recoveryInflight = recoveryFn()
      .catch(() => false)
      .finally(() => {
        recoveryInflight = null;
      });
  }
  return recoveryInflight;
}

function cancelledError(): ApiError {
  return new ApiError({ code: "CANCELLED", message: "请求已取消", retryable: false });
}

function retryAfterMs(headers: Record<string, string> | undefined): number {
  if (!headers) return 0;
  const raw = headers["Retry-After"] || headers["retry-after"];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function authFailed(statusCode: number, body: any): boolean {
  if (statusCode === 401) return true;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return false;
    }
  }
  return !!(body && body.error && body.error.code === "AUTH_REQUIRED");
}

function parseBody<T>(statusCode: number, body: any, headers?: Record<string, string>): T {
  if (statusCode >= 200 && statusCode < 300 && body && body.data !== undefined) {
    return body.data as T;
  }
  if (typeof body === "string") {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      throw new ApiError(
        { code: "INVALID_RESPONSE", message: "响应格式异常", retryable: true },
        statusCode
      );
    }
    return parseBody<T>(statusCode, parsed, headers);
  }
  const err: ApiErrorBody =
    body && body.error
      ? body.error
      : { code: "NETWORK_ERROR", message: "网络异常，请重试。", retryable: true };
  throw new ApiError(err, statusCode, retryAfterMs(headers));
}

interface RequestOptions {
  path: string;
  // wx.request 不支持 PATCH，更新类接口统一用 POST（后端同时接受 PATCH/POST）
  method?: "GET" | "POST" | "DELETE";
  data?: Record<string, any>;
  idempotencyKey?: string;
  onTask?: (task: WechatMiniprogram.RequestTask) => void;
  isCancelled?: () => boolean;
  timeout?: number;
  skipAuthRecovery?: boolean;
}

export function request<T>(options: RequestOptions): Promise<T> {
  const frozen = {
    path: options.path,
    method: options.method || "GET",
    data: options.data ? JSON.parse(JSON.stringify(options.data)) : options.data,
    idempotencyKey: options.idempotencyKey,
    timeout: options.timeout,
  };
  const send = (authRecoveryUsed: boolean): Promise<T> => {
    if (options.isCancelled && options.isCancelled()) {
      return Promise.reject(cancelledError());
    }
    const header: Record<string, string> = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) header["Authorization"] = `Bearer ${token}`;
    if (frozen.idempotencyKey) header["Idempotency-Key"] = frozen.idempotencyKey;

    return new Promise<T>((resolve, reject) => {
      const task = wx.request({
        url: `${API_BASE_URL}${frozen.path}`,
        method: frozen.method,
        data: frozen.data,
        header,
        timeout: frozen.timeout,
        success: async (res) => {
          if (options.isCancelled && options.isCancelled()) {
            reject(cancelledError());
            return;
          }
          if (authFailed(res.statusCode, res.data) && !options.skipAuthRecovery && !authRecoveryUsed) {
            const ok = await recoverOnce();
            if (options.isCancelled && options.isCancelled()) {
              reject(cancelledError());
              return;
            }
            if (ok) {
              send(true).then(resolve, reject);
              return;
            }
          }
          try {
            resolve(parseBody<T>(res.statusCode, res.data, res.header));
          } catch (err) {
            reject(err);
          }
        },
        fail: (res) => {
          const msg = (res && res.errMsg) || "";
          const code = /abort/i.test(msg)
            ? "ABORTED"
            : /timeout/i.test(msg)
              ? "TIMEOUT"
              : "NETWORK_ERROR";
          reject(
            new ApiError(
              {
                code,
                message: code === "ABORTED" ? "请求已取消" : code === "TIMEOUT" ? "请求超时，请重试" : "网络异常，请重试。",
                retryable: code !== "ABORTED",
              }
            )
          );
        },
      });
      if (options.onTask && task) options.onTask(task);
    });
  };
  return send(false);
}

export function uploadFile<T>(options: {
  path: string;
  filePath: string;
  name: string;
  formData?: Record<string, any>;
  onProgress?: (percent: number) => void;
  onTask?: (task: WechatMiniprogram.UploadTask) => void;
  isCancelled?: () => boolean;
  timeout?: number;
  skipAuthRecovery?: boolean;
}): Promise<T> {
  const frozen = {
    path: options.path,
    filePath: options.filePath,
    name: options.name,
    formData: options.formData ? JSON.parse(JSON.stringify(options.formData)) : options.formData,
    timeout: options.timeout,
  };
  const send = (authRecoveryUsed: boolean): Promise<T> => {
    if (options.isCancelled && options.isCancelled()) {
      return Promise.reject(cancelledError());
    }
    const header: Record<string, string> = {};
    const token = getToken();
    if (token) header["Authorization"] = `Bearer ${token}`;

    return new Promise<T>((resolve, reject) => {
      const task = wx.uploadFile({
        url: `${API_BASE_URL}${frozen.path}`,
        filePath: frozen.filePath,
        name: frozen.name,
        formData: frozen.formData,
        header,
        timeout: frozen.timeout,
        success: async (res) => {
          if (options.isCancelled && options.isCancelled()) {
            reject(cancelledError());
            return;
          }
          if (authFailed(res.statusCode, res.data) && !options.skipAuthRecovery && !authRecoveryUsed) {
            const ok = await recoverOnce();
            if (options.isCancelled && options.isCancelled()) {
              reject(cancelledError());
              return;
            }
            if (ok) {
              send(true).then(resolve, reject);
              return;
            }
          }
          try {
            resolve(parseBody<T>(res.statusCode, res.data, (res as any).header));
          } catch (err) {
            reject(err);
          }
        },
        fail: (res) => {
          const msg = (res && res.errMsg) || "";
          const code = /abort/i.test(msg)
            ? "ABORTED"
            : /timeout/i.test(msg)
              ? "TIMEOUT"
              : "NETWORK_ERROR";
          reject(
            new ApiError(
              {
                code,
                message: code === "ABORTED" ? "上传已取消" : code === "TIMEOUT" ? "上传超时，请重试" : "网络异常，请重试。",
                retryable: code !== "ABORTED",
              }
            )
          );
        },
      });
      if (task) {
        if (options.onProgress) {
          task.onProgressUpdate((res) => {
            if (options.isCancelled && options.isCancelled()) return;
            options.onProgress!(res.progress);
          });
        }
        if (options.onTask) options.onTask(task);
      }
    });
  };
  return send(false);
}

/** 统一错误提示；AUTH_REQUIRED 时跳回登录页。 */
export function showApiError(err: unknown, fallback = "网络异常，请重试。") {
  const message = err instanceof ApiError ? err.message : fallback;
  if (err instanceof ApiError && err.code === "AUTH_REQUIRED") {
    clearToken();
    wx.reLaunch({ url: "/pages/launch/index" });
    return;
  }
  showNotice(message);
}
