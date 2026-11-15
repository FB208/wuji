import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, makePage, MP_DIR } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const PAGE = path.join(MP_DIR, "pages/launch/index.js");
function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function env(overrides = {}) {
  const calls = { login: [], toasts: [], switchTabOpts: [], navs: [], relaunches: [] };
  const storage = new Map();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ""),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: (k) => storage.delete(k),
    showToast: (o) => calls.toasts.push(o.title),
    navigateTo: (o) => calls.navs.push(o.url),
    reLaunch: (o) => calls.relaunches.push(o.url),
    switchTab: (o) => calls.switchTabOpts.push(o),
  });
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
  };
  const scopeMod = loadModule(K("services/page-scope.js"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const authMod = {
    ensureLogin: (opts) => { calls.login.push(opts && opts.interactive === true ? true : false); return overrides.ensureLogin ? overrides.ensureLogin(store, opts) : Promise.resolve(); },
  };
  let def;
  loadModule(PAGE, {
    globals: { wx: wxBase, Page: (d) => { def = d; } },
    mocks: {
      [K("services/api")]: apiMod, [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod, [K("store/index")]: storeMod,
    },
  });
  const page = makePage(def);
  page.onLoad();
  return { page, calls, store, apiMod };
}
const FAM = [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }];

test("1 onLoad0auth→show1auth→resolve nav1", async () => {
  const d = deferred();
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return d.p; } });
  assert.equal(e.calls.login.length, 0);
  e.page.onShow();
  await flush(3);
  assert.equal(e.calls.login.length, 1);
  assert.equal(e.calls.switchTabOpts.length, 0);
  d.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
});
test("2 失败真retry第二次interactive=true", async () => {
  const e = env({ ensureLogin: () => Promise.reject(new Error("x")) });
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.failed, true);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.login.length, 2);
  assert.equal(e.calls.login[0], false);
  assert.equal(e.calls.login[1], true);
});
test("3 hide后resolve 0nav/UI", async () => {
  const d = deferred();
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return d.p; } });
  e.page.onShow();
  await flush(3);
  e.page.onHide();
  const sd = (e.page._setDataCalls || []).length;
  d.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 0);
  assert.equal((e.page._setDataCalls || []).length, sd);
});
test("4 hide reject 0toast/UI + unload reject 0写", async () => {
  const d = deferred();
  const e = env({ ensureLogin: () => d.p });
  e.page.onShow();
  await flush(3);
  e.page.onHide();
  const sd = (e.page._setDataCalls || []).length;
  d.reject(new Error("x"));
  await flush();
  assert.equal(e.calls.toasts.length, 0);
  assert.equal((e.page._setDataCalls || []).length, sd);
  const d2 = deferred();
  const e2 = env({ ensureLogin: () => d2.p });
  e2.page.onShow();
  await flush(3);
  e2.page.onUnload();
  const sd2 = (e2.page._setDataCalls || []).length;
  d2.reject(new Error("x"));
  await flush();
  assert.equal((e2.page._setDataCalls || []).length, sd2);
});
test("5a show→hide→show第二pending，旧resolve不清新busy", async () => {
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return ++n === 1 ? d1.p : d2.p; } });
  e.page.onShow();
  await flush(3);
  assert.equal(e.calls.login.length, 1);
  e.page.onHide();
  e.page.onShow();
  await flush(3);
  assert.equal(e.calls.login.length, 2);
  assert.equal(e.page.data.busy, true);
  const sd = (e.page._setDataCalls || []).length;
  d1.resolve();
  await flush();
  assert.equal((e.page._setDataCalls || []).length, sd);
  assert.equal(e.page.data.busy, true);
  assert.equal(e.page.data.failed, false);
  assert.equal(e.calls.switchTabOpts.length, 0);
  d2.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
});
test("5b show→hide→show第二pending，旧reject不清新busy", async () => {
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return ++n === 1 ? d1.p : d2.p; } });
  e.page.onShow();
  await flush(3);
  e.page.onHide();
  e.page.onShow();
  await flush(3);
  assert.equal(e.calls.login.length, 2);
  d1.reject(new Error("x"));
  await flush();
  assert.equal(e.page.data.busy, true);
  assert.equal(e.page.data.failed, false);
  assert.equal(e.calls.switchTabOpts.length, 0);
  d2.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
});
test("6 双retry busy=1 auth；fail后双tap仍1新call；navigating retry0新", async () => {
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return ++n === 1 ? d1.p : d2.p; } });
  e.page.onShow();
  await flush(2);
  e.page.onRetry();
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.login.length, 1);
  d1.reject(new Error("x"));
  await flush();
  assert.equal(e.page.data.failed, true);
  e.page.onRetry();
  e.page.onRetry();
  await flush(3);
  assert.equal(e.calls.login.length, 2);
  assert.equal(e.calls.login[1], true);
  d2.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
  e.page.onRetry();
  assert.equal(e.calls.login.length, 2);
});
test("7 resolve UID0不nav且retry可完成；-1同", async () => {
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  const e = env({ ensureLogin: (s) => { const k = ++n; if (k === 2) s.applyMe({ id: 1 }, FAM); return k === 2 ? d2.p : d1.p; } });
  e.page.onShow();
  await flush(3);
  d1.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 0);
  assert.equal(e.page.data.errorText, "登录未完成，请重试");
  e.page.onRetry();
  await flush(3);
  d2.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
  const e2 = env({ ensureLogin: (s) => { s.applyMe({ id: -1 }, FAM); return Promise.resolve(); } });
  e2.page.onShow();
  await flush();
  assert.equal(e2.calls.switchTabOpts.length, 0);
});
test("8 switchTab.fail可见→failed+真retry；hidden调用旧fail0写", async () => {
  const d = deferred();
  const e = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return d.p; } });
  e.page.onShow();
  await flush(3);
  d.resolve();
  await flush();
  assert.equal(e.calls.switchTabOpts.length, 1);
  const opts = e.calls.switchTabOpts[0];
  opts.fail();
  await flush();
  assert.equal(e.page.data.failed, true);
  assert.equal(e.page._navigating, false);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.login.length, 2);
  assert.equal(e.calls.login[1], true);
  assert.equal(e.calls.switchTabOpts.length, 2);
  const e2 = env({ ensureLogin: (s) => { s.applyMe({ id: 1 }, FAM); return Promise.resolve(); } });
  e2.page.onShow();
  await flush();
  e2.page.onHide();
  const sd = (e2.page._setDataCalls || []).length;
  e2.calls.switchTabOpts[0].fail();
  await flush();
  assert.equal((e2.page._setDataCalls || []).length, sd);
});
test("9 LOGIN_BLOCKED留页内，真retry才interactive", async () => {
  let blocked = true;
  const e = env({
    ensureLogin: (s) => {
      if (blocked) { const err = new e.apiMod.ApiError({ code: "LOGIN_BLOCKED", message: "blocked", retryable: false }); return Promise.reject(err); }
      s.applyMe({ id: 1 }, FAM);
      return Promise.resolve();
    },
  });
  e.page.onShow();
  await flush();
  assert.equal(e.calls.relaunches.length, 0);
  assert.equal(e.page.data.failed, true);
  blocked = false;
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.login[1], true);
  assert.equal(e.calls.relaunches.length, 0);
  assert.equal(e.calls.switchTabOpts.length, 1);
});
test("10 hidden retry0auth/nav", async () => {
  const e = env();
  e.page.onShow();
  await flush(2);
  e.page.onHide();
  e.page.onRetry();
  assert.equal(e.calls.login.length, 1);
  assert.equal(e.calls.switchTabOpts.length, 0);
});
