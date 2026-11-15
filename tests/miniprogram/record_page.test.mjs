import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, makePage, MP_DIR, noticeMock } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const PAGE = path.join(MP_DIR, "pages/record/index.js");
function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function makeClock() {
  const timers = new Map(); let seq = 0; let now = 0;
  return {
    setTimeout: (cb, ms) => { const id = seq++; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, t] of Array.from(timers).sort((a, b) => a[1].due - b[1].due)) if (t.due <= now) { timers.delete(id); t.cb(); } },
  };
}
function env(overrides = {}) {
  const calls = { req: [], upload: [], transcribe: [], login: 0, toasts: [], switchTab: [], takePhoto: [] };
  const storage = new Map();
  const clock = makeClock();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: (k) => storage.delete(k),
    showToast: (o) => calls.toasts.push(o.title),
    switchTab: (o) => calls.switchTab.push(o.url),
    reLaunch: () => {},
    createCameraContext: () => ({
      takePhoto: (o) => { calls.takePhoto.push(1); o.success({ tempImagePath: "cam1.jpg" }); },
    }),
    chooseMedia: (o) => { if (overrides.chooseMedia) overrides.chooseMedia(o); else o.success({ tempFiles: [{ tempFilePath: "alb1.jpg" }] }); },
    openSetting: () => {},
  });
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
    request: (o) => { calls.req.push({ path: o.path, method: o.method, data: JSON.parse(JSON.stringify(o.data || {})), key: o.idempotencyKey }); return overrides.request ? overrides.request(o) : Promise.resolve({}); },
    newIdempotencyKey: (() => { let n = 0; return () => "key" + (++n); })(),
  };
  const scopeMod = loadModule(K("services/page-scope.js"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const uploadMod = {
    uploadImage: (fid, p, o) => { calls.upload.push({ fid, p }); return overrides.upload ? overrides.upload({ fid, p }) : Promise.resolve({ image_token: "img1" }); },
    transcribeAudio: (p, o) => { calls.transcribe.push(p); return overrides.transcribe ? overrides.transcribe(p) : Promise.resolve({ transcript: "t" }); },
    recordItem: (fid, imageToken, transcript, key, o) => {
      calls.req.push({ path: "/items/record", method: "POST", data: { family_id: fid, image_token: imageToken, transcript }, key });
      return overrides.request ? overrides.request(o) : Promise.resolve({});
    },
  };
  let def;
  loadModule(PAGE, {
    globals: { wx: wxBase, Page: (d) => { def = d; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    mocks: {
      [K("services/api")]: apiMod,
      [K("services/auth")]: { ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin() : Promise.resolve(); } },
      [K("services/page-scope")]: scopeMod,
      [K("store/index")]: storeMod,
      [K("services/upload")]: uploadMod,
      [K("services/notice")]: noticeMock(wxBase),
    },
  });
  const page = makePage(def);
  page.onLoad();
  return { page, calls, store, clock, apiMod };
}
async function boot(e) { e.page.onShow(); await flush(); }

test("A 双media并行才一次POST+999/1000ms边界", async () => {
  const d1 = deferred(), d2 = deferred();
  const e = env({ upload: () => d1.p, transcribe: () => d2.p });
  await boot(e);
  e.page.takePhoto();
  e.page.onRecordStart();
  e.page.onRecordFinish({ detail: { tempFilePath: "a1.m4a" } });
  await flush(3);
  assert.equal(e.calls.upload.length, 1);
  assert.equal(e.calls.transcribe.length, 1);
  d1.resolve({ image_token: "img1" });
  await flush(4);
  assert.equal(e.calls.req.length, 0);
  d2.resolve({ transcript: "t" });
  await flush();
  assert.equal(e.calls.req.length, 1);
  assert.equal(e.page.data.state, "SUCCESS");
  e.clock.advance(999);
  assert.equal(e.calls.switchTab.length, 0);
  e.clock.advance(1);
  assert.equal(e.calls.switchTab.length, 1);
});
test("B POST失败retry整body同key+无重复media；hide/show保图", async () => {
  let n = 0;
  const e = env({ request: () => { n++; return n === 1 ? Promise.reject(new Error("net")) : Promise.resolve({}); } });
  await boot(e);
  e.page.takePhoto();
  e.page.onRecordFinish({ detail: { tempFilePath: "a1.m4a" } });
  await flush();
  assert.equal(e.page.data.state, "FAILED");
  const key = e.calls.req[0].key;
  const body = e.calls.req[0].data;
  e.page.onHide();
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.photoPath, "cam1.jpg");
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.req.length, 2);
  assert.equal(e.calls.req[1].key, key);
  assert.deepEqual(e.calls.req[1].data, body);
  assert.equal(e.calls.upload.length, 1);
  assert.equal(e.calls.transcribe.length, 1);
});
test("C 一media失败只补失败步骤", async () => {
  let t = 0;
  const e = env({ transcribe: () => { t++; return t === 1 ? Promise.reject(new Error("net")) : Promise.resolve({ transcript: "t2" }); } });
  await boot(e);
  e.page.takePhoto();
  e.page.onRecordFinish({ detail: { tempFilePath: "a1.m4a" } });
  await flush();
  assert.equal(e.page.data.state, "FAILED");
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.upload.length, 1);
  assert.equal(e.calls.transcribe.length, 2);
});
test("D POST RECORD_PARSE_FAILED→READY重新录音新key成功", async () => {
  let n = 0;
  const e = env({
    request: () => {
      n++;
      if (n === 1) { const err = new e.apiMod.ApiError({ code: "RECORD_PARSE_FAILED", message: "x", retryable: false }); return Promise.reject(err); }
      return Promise.resolve({});
    },
  });
  await boot(e);
  e.page.takePhoto();
  e.page.onRecordFinish({ detail: { tempFilePath: "a1.m4a" } });
  await flush();
  assert.equal(e.page.data.state, "READY");
  assert.equal(e.page.data.photoPath, "cam1.jpg");
  e.page.onRecordStart();
  e.page.onRecordFinish({ detail: { tempFilePath: "a2.m4a" } });
  await flush();
  assert.equal(e.calls.req.length, 2);
  assert.notEqual(e.calls.req[1].key, e.calls.req[0].key);
  assert.equal(e.page.data.state, "SUCCESS");
});
test("F 账号/家庭变旧请求不写UI", async () => {
  const d = deferred();
  const e = env({ request: () => d.p });
  await boot(e);
  e.page.takePhoto();
  e.page.onRecordFinish({ detail: { tempFilePath: "a1.m4a" } });
  await flush(3);
  e.store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  d.resolve({});
  await flush();
  assert.notEqual(e.page.data.state, "SUCCESS");
  assert.equal(e.calls.switchTab.length, 0);
});
test("E 相册选图经onHide/onShow往返仍接收", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } });
  await boot(e);
  e.page.chooseFromAlbum();
  e.page.onHide();
  e.page.onShow();
  await flush();
  picker.current.success({ tempFiles: [{ tempFilePath: "alb2.jpg" }] });
  assert.equal(e.page.data.state, "READY");
  assert.equal(e.page.data.photoPath, "alb2.jpg");
});
test("E2 相册回调早于onShow也接收且恢复后保留", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } });
  await boot(e);
  e.page.chooseFromAlbum();
  e.page.onHide();
  picker.current.success({ tempFiles: [{ tempFilePath: "alb3.jpg" }] });
  assert.equal(e.page.data.photoPath, "alb3.jpg");
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.state, "READY");
  assert.equal(e.page.data.photoPath, "alb3.jpg");
});
test("E3 相册回调在scope变化后丢弃", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } });
  await boot(e);
  e.page.chooseFromAlbum();
  e.store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  picker.current.success({ tempFiles: [{ tempFilePath: "alb4.jpg" }] });
  assert.equal(e.page.data.state, "CAMERA");
  assert.equal(e.page.data.photoPath, "");
});
test("模板保留原class/camera与record绑定", async () => {
  const wxml = (await import("node:fs")).readFileSync(path.join(MP_DIR, "pages/record/index.wxml"), "utf8");
  assert.ok(wxml.includes('class="record-page"'));
  assert.ok(wxml.includes('class="photo-area brutal-card"'));
  assert.ok(wxml.includes('class="camera"'));
  assert.ok(wxml.includes("recordstart"));
  assert.ok(wxml.includes("recorderror"));
  assert.ok(wxml.includes("permissiondenied"));
  assert.ok(wxml.includes("takePhoto"));
});
