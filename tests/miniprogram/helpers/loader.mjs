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
