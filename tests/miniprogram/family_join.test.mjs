import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTsModule, mockWx, makePage, MP_DIR, noticeMock } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const PAGE = path.join(MP_DIR, "pages/family-join/index.ts");
function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function makeClock() {
  const timers = new Map(); let seq = 0; let now = 0;
  return { timers, get now() { return now; },
    setTimeout: (cb, ms) => { const id = seq++; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, t] of Array.from(timers).sort((a, b) => a[1].due - b[1].due)) {
          if (t.due <= now) { timers.delete(id); ran = true; t.cb(); }
        }
      }
    } };
}
function env(overrides = {}, query = { invite_token: "tok1" }) {
  const calls = { get: [], post: [], login: 0, me: 0, toasts: [], navs: [], relaunches: [], switchTab: [] };
  const storage = new Map();
  const clock = makeClock();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    showToast: (o) => calls.toasts.push(o.title),
    navigateTo: (o) => calls.navs.push(o.url),
    reLaunch: (o) => calls.relaunches.push(o.url),
    switchTab: (o) => calls.switchTab.push(o.url),
  });
  const storeMod = loadTsModule(K("store/index.ts"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  }
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
    request: (o) => {
      if (o.path === "/families/join") { calls.post.push(JSON.parse(JSON.stringify(o.data))); return overrides.post ? overrides.post(o) : Promise.resolve({ family_id: 20 }); }
      calls.get.push(o.path);
      return overrides.request ? overrides.request(o) : Promise.resolve({ family_id: 20, family_name: "王家", owner_nickname: "爸" });
    },
  };
  const scopeMod = loadTsModule(K("services/page-scope.ts"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin(store) : Promise.resolve(); },
    refreshMe: (skip, pref) => {
      calls.me++;
      if (overrides.refreshMe) return overrides.refreshMe(store, pref);
      store.applyMe(store.user || { id: 1 }, [...store.families, { id: pref, name: "新", owner_user_id: 9, role: "member" }], pref);
      return Promise.resolve({ user: store.user, families: store.families });
    },
  };
  let def;
  loadTsModule(PAGE, {
    globals: { wx: wxBase, Page: (d) => { def = d; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    mocks: {
      [K("services/api")]: apiMod, [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod, [K("store/index")]: storeMod,
      [K("services/notice")]: noticeMock(wxBase),
    },
  });
  const page = makePage(def);
  page.onLoad(query);
  return { page, calls, store, apiMod, clock };
}
async function boot(e) { e.page.onShow(); await flush(); }

test("a auth失败errorText可见真retry", async () => {
  let fails = 1;
  const { page, calls } = env({ ensureLogin: () => (fails-- > 0 ? Promise.reject(new Error("x")) : Promise.resolve()) });
  page.onShow();
  await flush();
  assert.equal(page.data.ready, false);
  assert.equal(page.data.loaded, false);
  assert.equal(page.data.errorText, "登录失败，请重试");
  page.onRetry();
  await flush();
  assert.equal(calls.login, 2);
  assert.equal(calls.get.length, 1);
  assert.equal(page.data.familyName, "王家");
});
test("bad token 三种0auth0GET", async () => {
  for (const q of [{ invite_token: "" }, { invite_token: "%E0%A4%A" }, { invite_token: "x".repeat(5000) }]) {
    const { page, calls } = env({}, q);
    page.onShow();
    await flush();
    assert.equal(calls.login, 0);
    assert.equal(calls.get.length, 0);
    assert.equal(page.data.invalid, true);
  }
});
test("b pending preview换family/UID不写", async () => {
  const d = deferred();
  const { page, calls, store } = env({ request: () => d.p });
  page.onShow();
  await flush(3);
  assert.equal(calls.get.length, 1);
  store.applyMe({ id: 1 }, [{ id: 99, name: "g", owner_user_id: 1, role: "member" }]);
  d.resolve({ family_id: 20, family_name: "旧名", owner_nickname: "" });
  await flush();
  assert.equal(page.data.familyName, "");
  assert.equal(page.data.joining, false);
});
test("b2 pending preview换UID reject不写", async () => {
  const d = deferred();
  const { page, calls, store } = env({ request: () => d.p });
  page.onShow();
  await flush(3);
  assert.equal(calls.get.length, 1);
  store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  d.reject(new Error("x"));
  await flush();
  assert.equal(page.data.familyName, "");
});
test("c join成功→Me applyMe新增20+preferred20→toast+599/600 nav", async () => {
  const { page, calls, store, clock } = env();
  await boot({ page, calls });
  assert.equal(page.data.loaded, true);
  page.onJoin();
  await flush();
  assert.equal(calls.post.length, 1);
  assert.equal(calls.me, 1);
  assert.equal(store.currentFamilyId, 20);
  assert.equal(calls.toasts.filter((t) => t === "加入成功").length, 1);
  assert.equal(page.data.joined, true);
  assert.equal(calls.switchTab.length, 1);
});
test("d POST pending换UID→resolve 0Me/0toast", async () => {
  const d = deferred();
  const { page, calls, store } = env({ post: () => d.p });
  await boot({ page, calls });
  page.onJoin();
  await flush(3);
  assert.equal(calls.post.length, 1);
  store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  d.resolve({ family_id: 20 });
  await flush();
  assert.equal(calls.me, 0);
  assert.equal(calls.toasts.length, 0);
});
test("e Me pending换UID stale不apply 0toast", async () => {
  const d = deferred();
  const { page, calls, store } = env({
    refreshMe: (s, pref) => d.p,
  });
  await boot({ page, calls });
  page.onJoin();
  await flush(3);
  assert.equal(calls.me, 1);
  store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  d.resolve(null);
  await flush();
  assert.equal(calls.toasts.length, 0);
  assert.notEqual(store.currentFamilyId, 20);
  assert.equal(page.data.joining, false);
  assert.equal(page.data.familyName, "");
  assert.ok(page.data.errorText);
});
test("f hide during preview 0setData/toast/nav", async () => {
  const d = deferred();
  const { page, calls } = env({ request: () => d.p });
  page.onShow();
  await flush(3);
  assert.equal(calls.get.length, 1);
  page.onHide();
  const sd = (page._setDataCalls || []).length;
  d.resolve({ family_id: 20, family_name: "旧", owner_nickname: "" });
  await flush();
  assert.equal((page._setDataCalls || []).length, sd);
  assert.equal(calls.toasts.length, 0);
});
test("f2 hide during POST 0toast/nav", async () => {
  const d = deferred();
  const { page, calls } = env({ post: () => d.p });
  await boot({ page, calls });
  page.onJoin();
  await flush(3);
  page.onHide();
  d.resolve({ family_id: 20 });
  await flush();
  assert.equal(calls.toasts.length, 0);
  assert.equal(calls.switchTab.length, 0);
});
test("g hide期间join完成不再nav", async () => {
  const d = deferred();
  const { page, calls } = env({ post: () => d.p });
  await boot({ page, calls });
  page.onJoin();
  await flush();
  assert.equal(calls.post.length, 1);
  page.onHide();
  d.resolve({ family_id: 20 });
  await flush();
  assert.equal(calls.switchTab.length, 0);
});
test("h unknown join不自动重提 retry同token", async () => {
  const { page, calls } = env({ post: () => Promise.reject(new Error("net")) });
  await boot({ page, calls });
  page.onJoin();
  await flush();
  assert.equal(calls.post.length, 1);
  assert.equal(page.data.joining, false);
  page.onRetry();
  await flush();
  assert.equal(calls.post.length, 1);
  assert.equal(calls.get.length, 2);
  await page.onJoin();
  assert.equal(calls.post.length, 2);
  assert.deepEqual(calls.post[0], calls.post[1]);
});
test("i hide/show新join不被旧finally清", async () => {
  const old = deferred(), latest = deferred();
  let posts = 0;
  const { page, calls } = env({ post: () => ++posts === 1 ? old.p : latest.p });
  await boot({ page, calls });
  const first = page.onJoin();
  assert.equal(calls.post.length, 1);
  page.onHide();
  page.onShow();
  await flush();
  const second = page.onJoin();
  assert.equal(calls.post.length, 2);
  assert.equal(page.data.joining, true);
  old.resolve({ family_id: 20 });
  await first;
  assert.equal(page.data.joining, true);
  assert.equal(calls.me, 0);
  latest.resolve({ family_id: 20 });
  await second;
  assert.equal(page.data.joining, false);
  assert.equal(page.data.joined, true);
  assert.equal(calls.me, 1);
  assert.deepEqual(calls.toasts, ["加入成功"]);
  page.onHide();
});

test("join: 真cold在ensureLogin里建立用户和家庭scope", async () => {
  let before = -1;
  const e = env({ cold: true, ensureLogin: (store) => {
    before = store.user ? store.user.id : 0;
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
    return Promise.resolve();
  } });
  e.page.onJoin();
  assert.equal(e.calls.post.length, 0);
  await boot(e);
  assert.equal(before, 0);
  assert.equal(e.calls.get.length, 1);
  assert.equal(e.page.data.familyName, "王家");
});

test("join: Me等待时hide，合法apply新家也不能回写旧页或导航", async () => {
  const d = deferred();
  const e = env({ refreshMe: () => d.p });
  await boot(e);
  const pending = e.page.onJoin();
  await flush();
  assert.equal(e.calls.me, 1);
  e.page.onHide();
  const start = e.page._setDataCalls.length;
  e.store.applyMe({ id: 1 }, [...e.store.families, { id: 20, name: "新", role: "member" }], 20);
  d.resolve();
  await pending;
  e.clock.advance(1000);
  assert.equal(e.page._setDataCalls.length, start);
  assert.deepEqual(e.calls.toasts, []);
  assert.deepEqual(e.calls.switchTab, []);
});

test("join: 缺少有效预览family_id不显示可加入状态", async () => {
  const e = env({ request: () => Promise.resolve({ family_name: "错误预览", owner_nickname: "" }) });
  await boot(e);
  assert.ok(e.page.data.errorText);
  assert.equal(e.page.data.loaded, false);
  e.page.onJoin();
  assert.equal(e.calls.post.length, 0);
});
test("j preview20 join返回30拒绝选家", async () => {
  const { page, calls, store } = env({ post: () => Promise.resolve({ family_id: 30 }) });
  await boot({ page, calls });
  assert.equal(page._previewFID, 20);
  page.onJoin();
  await flush();
  assert.equal(calls.me, 0);
  assert.notEqual(store.currentFamilyId, 30);
  assert.equal(page.data.errorText, "加入失败，请重试");
});
test("k joining时onRetry不取消当前POST", async () => {
  const d = deferred();
  const { page, calls } = env({ post: () => d.p });
  await boot({ page, calls });
  page.onJoin();
  await flush(3);
  page.onRetry();
  await flush(2);
  d.resolve({ family_id: 20 });
  await flush();
  assert.equal(calls.post.length, 1);
  assert.equal(page.data.joined, true);
});
