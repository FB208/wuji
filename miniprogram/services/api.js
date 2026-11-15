/** HTTP 封装：统一响应结构、令牌、错误码处理（文档 13.1 / 13.6）。 */
const { showNotice } = require("./notice");

const API_BASE_URL = "http://192.129.159.139:10001/api/v1"; // 部署后替换为正式域名

const TOKEN_KEY = "wuji_access_token";

class ApiError extends Error {
  constructor(body, statusCode = 0, retryAfterMs = 0) {
    super(body.message);
    this.code = body.code;
    this.retryable = body.retryable;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || "";
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token);
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
}

function newIdempotencyKey() {
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

let recoveryFn = null;
let recoveryInflight = null;

function registerAuthRecovery(fn) {
  recoveryFn = fn;
}

function recoverOnce() {
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

function cancelledError() {
  return new ApiError({ code: "CANCELLED", message: "请求已取消", retryable: false });
}

function retryAfterMs(headers) {
  if (!headers) return 0;
  const raw = headers["Retry-After"] || headers["retry-after"];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function authFailed(statusCode, body) {
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

function parseBody(statusCode, body, headers) {
  if (statusCode >= 200 && statusCode < 300 && body && body.data !== undefined) {
    return body.data;
  }
  if (typeof body === "string") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      throw new ApiError(
        { code: "INVALID_RESPONSE", message: "响应格式异常", retryable: true },
        statusCode
      );
    }
    return parseBody(statusCode, parsed, headers);
  }
  const err =
    body && body.error
      ? body.error
      : { code: "NETWORK_ERROR", message: "网络异常，请重试。", retryable: true };
  throw new ApiError(err, statusCode, retryAfterMs(headers));
}

// options: { path, method?, data?, idempotencyKey?, onTask?, isCancelled?, timeout?, skipAuthRecovery? }
// wx.request 不支持 PATCH，更新类接口统一用 POST（后端同时接受 PATCH/POST）
function request(options) {
  const frozen = {
    path: options.path,
    method: options.method || "GET",
    data: options.data ? JSON.parse(JSON.stringify(options.data)) : options.data,
    idempotencyKey: options.idempotencyKey,
    timeout: options.timeout,
  };
  const send = (authRecoveryUsed) => {
    if (options.isCancelled && options.isCancelled()) {
      return Promise.reject(cancelledError());
    }
    const header = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) header["Authorization"] = `Bearer ${token}`;
    if (frozen.idempotencyKey) header["Idempotency-Key"] = frozen.idempotencyKey;

    return new Promise((resolve, reject) => {
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
            resolve(parseBody(res.statusCode, res.data, res.header));
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

// options: { path, filePath, name, formData?, onProgress?, onTask?, isCancelled?, timeout?, skipAuthRecovery? }
function uploadFile(options) {
  const frozen = {
    path: options.path,
    filePath: options.filePath,
    name: options.name,
    formData: options.formData ? JSON.parse(JSON.stringify(options.formData)) : options.formData,
    timeout: options.timeout,
  };
  const send = (authRecoveryUsed) => {
    if (options.isCancelled && options.isCancelled()) {
      return Promise.reject(cancelledError());
    }
    const header = {};
    const token = getToken();
    if (token) header["Authorization"] = `Bearer ${token}`;

    return new Promise((resolve, reject) => {
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
            resolve(parseBody(res.statusCode, res.data, res.header));
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
            options.onProgress(res.progress);
          });
        }
        if (options.onTask) options.onTask(task);
      }
    });
  };
  return send(false);
}

/** 统一错误提示；AUTH_REQUIRED 时跳回登录页。 */
function showApiError(err, fallback = "网络异常，请重试。") {
  const message = err instanceof ApiError ? err.message : fallback;
  if (err instanceof ApiError && err.code === "AUTH_REQUIRED") {
    clearToken();
    wx.reLaunch({ url: "/pages/launch/index" });
    return;
  }
  showNotice(message);
}

module.exports = {
  API_BASE_URL,
  ApiError,
  getToken,
  setToken,
  clearToken,
  newIdempotencyKey,
  registerAuthRecovery,
  request,
  uploadFile,
  showApiError,
};
