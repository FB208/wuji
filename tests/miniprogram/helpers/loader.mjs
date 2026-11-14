import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../miniprogram"
);

function normalizeKey(p) {
  return p.replace(/\\/g, "/").replace(/\.ts$/i, "");
}

function resolveImport(fromFile, spec) {
  return normalizeKey(path.resolve(path.dirname(fromFile), spec));
}

export function loadTsModule(absPath, { mocks = {}, globals = {} } = {}) {
  const src = fs.readFileSync(absPath, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    fileName: absPath,
  }).outputText;
  const module = { exports: {} };
  const req = (spec) => {
    const key = resolveImport(absPath, spec);
    if (Object.prototype.hasOwnProperty.call(mocks, key)) return mocks[key];
    throw new Error(`unmocked import '${spec}' (resolved: ${key}) from ${absPath}`);
  };
  const fn = new Function(
    "require", "module", "exports",
    "wx", "Page", "Component", "getApp", "App", "getCurrentPages",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "console", "Date",
    js
  );
  const g = globals;
  fn(
    req, module, module.exports,
    g.wx || {}, g.Page || (() => {}), g.Component || (() => {}), g.getApp || (() => ({})),
    g.App || (() => {}), g.getCurrentPages || (() => []),
    g.setTimeout || setTimeout, g.clearTimeout || clearTimeout,
    g.setInterval || setInterval, g.clearInterval || clearInterval,
    console, g.Date || Date
  );
  return module.exports;
}

/** services/notice 的测试替身：行为等价于未挂载页面时的原生回退（wx.showToast/showModal）。 */
export function noticeMock(wx) {
  const title = (m) => (typeof m === "string" ? m : (m && m.text) || "");
  return {
    bindNotice: () => () => {},
    registerNotice: () => {},
    showNotice: (m, cb) => {
      wx.showToast({ title: title(m), icon: "none" });
      if (cb) cb();
    },
    confirmNotice: (m) =>
      new Promise((resolve) =>
        wx.showModal({
          title: (m && m.title) || "提示",
          content: title(m),
          confirmText: m && m.confirmText,
          success: (r) => resolve(!!(r && r.confirm)),
          fail: () => resolve(false),
        })
      ),
    promptNotice: (m) =>
      new Promise((resolve) =>
        wx.showModal({
          title: (m && m.title) || "提示",
          editable: true,
          placeholderText: m && m.placeholderText,
          success: (r) => resolve(r && r.confirm ? r.content || "" : null),
          fail: () => resolve(null),
        })
      ),
  };
}

export function makePage(config) {
  const page = Object.create(null);
  Object.assign(page, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function (update) {
    Object.assign(this.data, update);
    this._setDataCalls = (this._setDataCalls || []).concat([update]);
  };
  return page;
}

export function mockWx(overrides = {}) {
  return {
    setStorageSync: () => {},
    getStorageSync: () => 0,
    removeStorageSync: () => {},
    showToast: () => {},
    navigateTo: () => {},
    switchTab: () => {},
    reLaunch: () => {},
    redirectTo: () => {},
    stopPullDownRefresh: () => {},
    showActionSheet: () => {},
    request: () => {},
    uploadFile: () => {},
    login: () => {},
    getSetting: async () => ({ authSetting: {} }),
    authorize: async () => {},
    ...overrides,
  };
}
