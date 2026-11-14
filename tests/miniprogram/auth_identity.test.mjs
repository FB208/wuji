import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTsModule, mockWx, MP_DIR } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;

function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

function env() {
  const calls = { req: [], progress: [], tokenWrites: [], headers: [] };
  const storage = new Map();
  const handlers = {};
  const pending = [];
  let wxLoginCb = null;
  let setStorageSpy = null;
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ""),
    setStorageSync: (k, v) => {
      const snap = setStorageSpy ? JSON.parse(JSON.stringify(setStorageSpy(k, v) || {})) : null;
      if (k === "wuji_access_token") calls.tokenWrites.push(v);
      storage.set(k, JSON.parse(JSON.stringify(v)));
      return snap;
    },
    removeStorageSync: (k) => storage.delete(k),
    login: (o) => { wxLoginCb = o; },
    request: (o) => {
      const m = o.url.match(/api\.example\.com\/api\/v1(.*)$/);
      const pathOnly = m ? m[1].split("?")[0] : o.url;
      calls.req.push({ path: pathOnly, method: o.method, data: JSON.parse(JSON.stringify(o.data || {})), header: JSON.parse(JSON.stringify(o.header || {})) });
      const task = { abort: () => {} };
      setTimeout(() => {
        const h = (handlers[pathOnly] || (() => ({ statusCode: 200, data: {} })));
        const res = h(pathOnly, o);
        if (res === "defer") {
          pending.push({ path: pathOnly, o });
          return;
        }
        o.success({ statusCode: res.statusCode, data: res.data, header: res.header || {} });
      }, 0);
      return task;
    },
    uploadFile: (o) => {
      const m = o.url.match(/api\.example\.com\/api\/v1(.*)$/);
      const pathOnly = m ? m[1].split("?")[0] : o.url;
      calls.req.push({ path: pathOnly + "#upload", method: "POST", data: JSON.parse(JSON.stringify(o.formData || {})) });
      const task = { abort: () => {}, _progressCb: null, onProgressUpdate(cb) { task._progressCb = cb; } };
      setTimeout(() => {
        const h = (handlers[pathOnly] || (() => ({ statusCode: 200, data: {} })));
        const res = h(pathOnly, o);
        if (res === "defer") {
          pending.push({ path: pathOnly, o, task });
          return;
        }
        o.success({ statusCode: res.statusCode, data: res.data, header: res.header || {} });
      }, 0);
      return task;
    },
    showToast: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
  });
  const storeMod = loadTsModule(K("store/index.ts"), { globals: { wx: wxBase } });
  const apiMod = loadTsModule(K("services/api.ts"), { globals: { wx: wxBase } });
  const authMod = loadTsModule(K("services/auth.ts"), {
    globals: { wx: wxBase },
    mocks: { [K("services/api")]: apiMod, [K("store/index")]: storeMod },
  });
  return {
    calls, storage, handlers, pending,
    store: storeMod.store, api: apiMod, auth: authMod,
    set setStorageSpy(fn) { setStorageSpy = fn; },
    get loginCb() { return wxLoginCb; },
    release(i, res) {
      const p = pending.splice(i, 1)[0];
      p.o.success({ statusCode: res.statusCode, data: res.data, header: res.header || {} });
    },
  };
}

const ME = (uid, families = []) => ({ statusCode: 200, data: { data: { user: { id: uid, nickname: null, avatar_url: null }, families } } });
const ERR = (code, sc) => ({ statusCode: sc, data: { error: { code, message: "x", retryable: false } } });
const FAM1 = { id: 10, name: "f", owner_user_id: 1, role: "owner" };

test("1 warm token2+storeUID1，/me返2→LOGIN_BLOCKED清光", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.storage.set("wuji_access_token", "tok2");
  e.handlers["/me"] = () => ME(2, []);
  await assert.rejects(e.auth.ensureLogin(), (err) => err.code === "LOGIN_BLOCKED");
  assert.equal(e.storage.get("wuji_access_token"), undefined);
  assert.equal(e.store.user, null);
  assert.equal(e.store.currentFamilyId, 0);
  assert.deepEqual(e.store.families, []);
  assert.equal(e.storage.get("wuji_login_blocked"), true);
});

test("2 automatic401→wxLogin(false)返UID2→blocked不发token/不重放", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.storage.set("wuji_access_token", "tok1");
  let bizN = 0;
  e.handlers["/biz"] = () => (++bizN === 1 ? ERR("AUTH_REQUIRED", 401) : { statusCode: 200, data: { data: { ok: 1 } } });
  e.handlers["/me"] = () => ME(1, [FAM1]);
  e.handlers["/auth/wechat-login"] = () => ({ statusCode: 200, data: { data: { access_token: "tok2", user: { id: 2, nickname: null, avatar_url: null }, current_family_id: 30 } } });
  e.api.registerAuthRecovery(e.auth.refreshCredentials);
  const p = e.api.request({ path: "/biz" }).then(
    () => "resolved",
    (err) => err
  );
  await flush(3);
  assert.equal(bizN, 1);
  e.loginCb.success({ code: "c1" });
  await flush(6);
  const err = await p;
  assert.ok(err instanceof Error, `expected rejection, got ${err}`);
  assert.equal(e.storage.get("wuji_login_blocked"), true);
  assert.equal(e.store.user, null);
  assert.notEqual(e.storage.get("wuji_access_token"), "tok2");
  assert.equal(bizN, 1);
});

test("5 oldMe pending→新token/user2→reject CANCELLED不清新session", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.storage.set("wuji_access_token", "tok1");
  e.handlers["/me"] = () => "defer";
  const p = e.auth.refreshMe();
  await flush(3);
  assert.equal(e.calls.req.length, 1);
  assert.equal(e.pending.length, 1);
  e.api.setToken("tokX");
  e.store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  e.release(0, ME(1, []));
  await assert.rejects(p, (err) => err.code === "CANCELLED");
  assert.equal(e.storage.get("wuji_access_token"), "tokX");
  assert.equal(e.store.user.id, 2);
  assert.notEqual(e.storage.get("wuji_login_blocked"), true);
});

test("6 ensureLogin Me pending→newer refreshMe应用B→ensure CANCELLED保B", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1], 10);
  e.storage.set("wuji_access_token", "tok1");
  const fams = [FAM1, { id: 20, name: "B", owner_user_id: 1, role: "member" }];
  let meN = 0;
  e.handlers["/me"] = () => (++meN === 1 ? "defer" : ME(1, fams));
  const ensureP = e.auth.ensureLogin();
  await flush(3);
  assert.equal(meN, 1);
  const me2 = e.auth.refreshMe();
  await flush();
  assert.equal(e.store.families.length, 2);
  e.release(0, ME(1, [FAM1]));
  await assert.rejects(ensureP, (err) => err.code === "CANCELLED");
  assert.equal(e.store.families.length, 2);
  await me2;
});

test("9 malformed login/me不publish", async () => {
  const e = env();
  e.storage.set("wuji_access_token", "tok1");
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.handlers["/me"] = () => ({ statusCode: 200, data: { data: { user: { id: 0 }, families: null } } });
  await assert.rejects(e.auth.refreshMe(), (err) => err.code === "INVALID_RESPONSE");
});
test("2b 真POST身份变化tok2从未写+0额外Me", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.storage.set("wuji_access_token", "tok1");
  let bizN = 0;
  e.handlers["/biz"] = () => (++bizN === 1 ? ERR("AUTH_REQUIRED", 401) : { statusCode: 200, data: { data: { ok: 1 } } });
  e.handlers["/me"] = () => ME(1, [FAM1]);
  e.handlers["/auth/wechat-login"] = () => ({ statusCode: 200, data: { data: { access_token: "tok2", user: { id: 2, nickname: null, avatar_url: null }, current_family_id: 30 } } });
  e.api.registerAuthRecovery(e.auth.refreshCredentials);
  const p = e.api.request({ path: "/biz", method: "POST", data: { a: 1 } }).then(() => "resolved", (err) => err);
  await flush(3);
  e.loginCb.success({ code: "c1" });
  await flush(6);
  const err = await p;
  assert.ok(err instanceof Error);
  assert.equal(e.calls.tokenWrites.includes("tok2"), false);
  assert.equal(bizN, 1);
  assert.equal(e.calls.req.filter((r) => r.path === "/me").length, 0);
  assert.equal(e.storage.get("wuji_login_blocked"), true);
});

test("3 interactive UID1→UID2，token发布瞬间旧身份已空", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1], 10);
  e.storage.set("wuji_access_token", "tok1");
  let atWrite = null;
  e.handlers["/auth/wechat-login"] = () => ({ statusCode: 200, data: { data: { access_token: "tok2", user: { id: 2, nickname: null, avatar_url: null }, current_family_id: 30 } } });
  e.handlers["/me"] = () => ME(2, [{ id: 30, name: "h", owner_user_id: 2, role: "member" }]);
  const login = e.auth.wxLogin(true);
  await flush(3);
  e.setStorageSpy = (k, v) => {
    if (k === "wuji_access_token" && v === "tok2") {
      atWrite = { uid: e.store.user ? e.store.user.id : 0, fid: e.store.currentFamilyId, fams: e.store.families.length };
    }
    return {};
  };
  e.loginCb.success({ code: "c1" });
  await flush(6);
  await login;
  assert.deepEqual(atWrite, { uid: 0, fid: 0, fams: 0 });
  assert.equal(e.storage.get("wuji_access_token"), "tok2");
});

test("4 同UID续签scope不变+重放原payload", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1], 10);
  e.storage.set("wuji_access_token", "tok1");
  const scopeBefore = e.store.captureScope();
  let bizN = 0;
  e.handlers["/biz"] = () => (++bizN === 1 ? ERR("AUTH_REQUIRED", 401) : { statusCode: 200, data: { data: { ok: 1 } } });
  e.handlers["/me"] = () => ME(1, [FAM1]);
  e.handlers["/auth/wechat-login"] = () => ({ statusCode: 200, data: { data: { access_token: "tok1b", user: { id: 1, nickname: null, avatar_url: null }, current_family_id: 10 } } });
  e.api.registerAuthRecovery(e.auth.refreshCredentials);
  const opts = { path: "/biz", method: "POST", data: { k: "orig" }, idempotencyKey: "key1" };
  const p = e.api.request(opts);
  await flush(3);
  e.loginCb.success({ code: "c1" });
  await flush(8);
  const res = await p;
  assert.equal(bizN, 2);
  assert.equal(e.storage.get("wuji_access_token"), "tok1b");
  assert.deepEqual(e.store.captureScope(), scopeBefore);
  const replays = e.calls.req.filter((r) => r.path === "/biz");
  assert.equal(replays[1].data.k, "orig");
  assert.equal(replays[1].header["Idempotency-Key"], "key1");
});

test("6b cold no-token→wxLogin1→Me1 pending→new Me应用B→ensure CANCELLED保B20", async () => {
  const e = env();
  let loginCalled = 0;
  const bodies = [];
  e.handlers["/auth/wechat-login"] = (p, o) => { bodies.push(o.data); return { statusCode: 200, data: { data: { access_token: "tok1", user: { id: 1, nickname: null, avatar_url: null }, current_family_id: 10 } } }; };
  const fams = [FAM1, { id: 20, name: "B", owner_user_id: 1, role: "member" }];
  let meN = 0;
  e.handlers["/me"] = () => (++meN === 1 ? "defer" : ME(1, fams));
  const ensureP = e.auth.ensureLogin({ interactive: true }).then(() => "ok", (err) => err);
  await flush(3);
  e.loginCb.success({ code: "c1" });
  await flush(4);
  assert.equal(meN, 1);
  const me2 = e.auth.refreshMe(true, 20);
  await flush();
  assert.equal(e.store.currentFamilyId, 20);
  assert.equal(e.store.families.length, 2);
  e.release(0, ME(1, [FAM1]));
  const r = await ensureP;
  assert.equal(r.code, "CANCELLED");
  assert.equal(e.store.currentFamilyId, 20);
  assert.equal(e.store.families.length, 2);
});

test("8 早cancel401→recovery0+recovery中cancel不重放", async () => {
  const e = env();
  e.store.applyMe({ id: 1 }, [FAM1]);
  e.storage.set("wuji_access_token", "tok1");
  let recN = 0;
  e.handlers["/biz"] = () => ERR("AUTH_REQUIRED", 401);
  e.api.registerAuthRecovery(() => { recN++; return Promise.resolve(true); });
  const p1 = e.api.request({ path: "/biz", isCancelled: () => true }).then(() => "ok", (err) => err.code);
  assert.equal(await p1, "CANCELLED");
  assert.equal(recN, 0);
  const e2 = env();
  e2.store.applyMe({ id: 1 }, [FAM1]);
  e2.storage.set("wuji_access_token", "tok1");
  e2.handlers["/biz"] = () => ERR("AUTH_REQUIRED", 401);
  const recGate = deferred();
  e2.api.registerAuthRecovery(() => recGate.p);
  let cancelled = false;
  const p2 = e2.api.request({ path: "/biz", isCancelled: () => cancelled }).then(() => "ok", (err) => err.code);
  await flush(3);
  cancelled = true;
  recGate.resolve(true);
  assert.equal(await p2, "CANCELLED");
  assert.equal(e2.calls.req.filter((r) => r.path === "/biz").length, 1);
});

test("9b malformed分开断言", async () => {
  for (const bad of [{ user: null, families: [] }, { families: [] }, { user: { id: -1 }, families: [] }, { user: { id: 1.5 }, families: [] }]) {
    const e = env();
    e.store.applyMe({ id: 1 }, [FAM1]);
    e.storage.set("wuji_access_token", "tok1");
    e.handlers["/me"] = () => ({ statusCode: 200, data: { data: bad } });
    await assert.rejects(e.auth.refreshMe(), (err) => err.code === "INVALID_RESPONSE");
  }
  const e2 = env();
  e2.handlers["/me"] = () => ({ statusCode: 200, data: { data: { user: { id: 5 }, families: null } } });
  await assert.rejects(e2.auth.refreshMe(), (err) => err.code === "INVALID_RESPONSE");
});
