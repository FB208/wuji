import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, mockWx, makePage, MP_DIR } from "./helpers/loader.mjs";

const PAGE = path.join(MP_DIR, "pages/items/index.js");
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}
async function flush(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeClock() {
  const timers = new Map();
  let seq = 0, now = 0;
  return {
    timers,
    setTimeout: (cb, ms) => { const id = seq++; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].cb();
      }
      now = target;
    },
  };
}

function env(overrides = {}) {
  const calls = { list: [], login: 0, me: 0, toasts: [], navs: [], relaunches: [], switchTab: [], stopPull: 0, aborted: [] };
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
    stopPullDownRefresh: () => { calls.stopPull++; },
  });
  const globals = { wx: wxBase, Page: (d) => { captured = d; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  const apiMod = {
    ApiError: class extends Error {
      constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; }
    },
    request: (o) => {
      if (o.onTask) o.onTask({ abort: () => calls.aborted.push(o.path) });
      calls.list.push(o.path);
      return overrides.request ? overrides.request(o) : Promise.resolve({ items: [{ id: 1, name: "a", updated_at: 0 }], total: 1 });
    },
  };
  const scopeMod = loadModule(K("services/page-scope.js"), {
    globals: {},
    mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod },
  });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin(store) : Promise.resolve(); },
    refreshMe: () => { calls.me++; return overrides.refreshMe ? overrides.refreshMe(store) : Promise.resolve({ user: store.user, families: store.families }); },
  };
  let captured;
  loadModule(PAGE, {
    globals,
    mocks: {
      [K("services/api")]: apiMod,
      [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod,
      [K("store/index")]: storeMod,
      [K("utils/format")]: { formatTime: (t) => "t" + t },
    },
  });
  const page = makePage(captured);
  page.onLoad();
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  }
  page.onShow();
  return { page, calls, store, apiMod, clock };
}

async function ready(page) { await flush(); assert.equal(page.data.ready, true); }

test("a pending旧GET被输入invalidate挡住", async () => {
  const d = deferred();
  const { page, calls, clock } = env({ request: () => d.p });
  await ready(page);
  assert.equal(calls.list.length, 1);
  page.onSearchInput({ detail: { value: "扳手" } });
  assert.equal(page.data.items.length, 0);
  assert.equal(calls.aborted.length, 1);
  d.resolve({ items: [{ id: 9, name: "old", updated_at: 0 }], total: 1 });
  await flush();
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.loading, false);
  clock.advance(300);
  await flush();
  assert.equal(calls.list.length, 2);
});

test("b 同frame换family后resolve和reject都清loading可retry", async () => {
  const d = deferred();
  const { page, store, calls } = env({ request: () => d.p });
  await ready(page);
  assert.equal(calls.list.length, 1);
  store.applyMe({ id: 1 }, [{ id: 20, name: "g", owner_user_id: 1, role: "member" }]);
  d.resolve({ items: [{ id: 9, name: "old", updated_at: 0 }], total: 1 });
  await flush();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.items.length, 0);
  assert.match(page.data.errorText, /切换/);
  page.onRetry();
  await flush();
  assert.match(calls.list[calls.list.length - 1], /family_id=20/);
});

test("b2 同frame换UID后旧GET不写", async () => {
  const d = deferred();
  const { page, store, calls } = env({ request: () => d.p });
  await ready(page);
  assert.equal(calls.list.length, 1);
  store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  d.resolve({ items: [{ id: 9, name: "old", updated_at: 0 }], total: 1 });
  await flush();
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.loading, false);
});

test("c 首屏成功→append pending→reload pending→旧append不写", async () => {
  const d2 = deferred();
  const d3 = deferred();
  let n = 0;
  const { page, calls } = env({
    request: () => (++n === 1 ? Promise.resolve({ items: [{ id: 1, name: "a", updated_at: 0 }], total: 50 })
      : n === 2 ? d2.p : d3.p),
  });
  await ready(page);
  assert.equal(calls.list.length, 1);
  page.onReachBottom();
  await flush(3);
  assert.equal(calls.list.length, 2);
  page.reload();
  await flush(3);
  assert.equal(calls.list.length, 3);
  d2.resolve({ items: [{ id: 2, name: "append", updated_at: 0 }], total: 50 });
  await flush();
  assert.equal(page.data.loading, true);
  d3.resolve({ items: [{ id: 5, name: "new", updated_at: 0 }], total: 1 });
  await flush();
  assert.deepEqual(page.data.items.map((i) => i.id), [5]);
  assert.equal(page.data.loading, false);
});

test("d hidden后tap/input/reload/pullDown/迟到均0写", async () => {
  const d = deferred();
  const { page, calls } = env({ request: () => d.p });
  await ready(page);
  page.onHide();
  const setDataBefore = (page._setDataCalls || []).length;
  const navBefore = calls.navs.length;
  const pullBefore = calls.stopPull;
  page.onItemTap({ detail: { item: { id: 1 } } });
  page.onSearchInput({ detail: { value: "x" } });
  page.onReachBottom();
  await page.onPullDownRefresh();
  d.resolve({ items: [{ id: 1, name: "a", updated_at: 0 }], total: 1 });
  await flush();
  assert.equal((page._setDataCalls || []).length, setDataBefore);
  assert.equal(calls.navs.length, navBefore);
  assert.equal(calls.stopPull, pullBefore);
});

test("e 403真实refreshMe替换families", async () => {
  const failed = deferred();
  let attempts = 0;
  const { page, calls, apiMod } = env({
    request: () => ++attempts === 1 ? failed.p : Promise.resolve({ items: [{ id: 20 }], total: 1 }),
    refreshMe: (store) => {
      store.applyMe({ id: 1 }, [{ id: 20, name: "g", owner_user_id: 1, role: "member" }]);
      return Promise.resolve();
    },
  });
  await ready(page);
  assert.equal(calls.list.length, 1);
  failed.reject(new apiMod.ApiError({ code: "FAMILY_FORBIDDEN", message: "x", retryable: false }, 403));
  await flush();
  assert.equal(calls.me, 1);
  assert.equal(page.data.ready, false);
  assert.equal(page.data.loading, false);
  assert.deepEqual(page.data.items, []);
  page.onRetry();
  await flush();
  assert.equal(page.data.ready, true);
  assert.match(calls.list[1], /family_id=20&q=&page=1/);
  assert.equal(page.data.items[0].id, 20);
});

test("f debounce精确边界+快速输入+id0 hide", async () => {
  const { page, calls, clock } = env();
  await ready(page);
  assert.equal(calls.list.length, 1);
  page.onSearchInput({ detail: { value: "a" } });
  assert.equal(clock.timers.size, 1);
  clock.advance(299);
  assert.equal(calls.list.length, 1);
  clock.advance(1);
  await flush();
  assert.equal(calls.list.length, 2);
  page.onSearchInput({ detail: { value: "ab" } });
  page.onSearchInput({ detail: { value: "abc" } });
  clock.advance(300);
  await flush();
  const qCalls = calls.list.filter((p) => p.includes("q=abc"));
  assert.equal(qCalls.length, 1);
  page.onSearchInput({ detail: { value: "x" } });
  page.onHide();
  assert.equal(clock.timers.size, 0);
  clock.advance(1000);
  await flush();
  const last = calls.list[calls.list.length - 1];
  assert.match(last, /q=abc/);
});

test("g append失败保留page/items，再bottom成功且无重复id", async () => {
  let n = 0;
  const { page, calls } = env({
    request: (o) => {
      n++;
      if (o.path.includes("page=2") && n === 2) return Promise.reject(new Error("net"));
      if (o.path.includes("page=2")) return Promise.resolve({ items: [{ id: 1, name: "dup", updated_at: 0 }, { id: 2, name: "b", updated_at: 0 }], total: 50 });
      return Promise.resolve({ items: [{ id: 1, name: "a", updated_at: 0 }], total: 50 });
    },
  });
  await ready(page);
  page.onReachBottom();
  await flush();
  assert.equal(page.data.items.length, 1);
  assert.equal(page._page, 1);
  assert.equal(page.data.hasMore, true);
  page.onReachBottom();
  page.onReachBottom();
  await flush();
  assert.equal(calls.list.filter((p) => p.includes("page=2")).length, 2);
  assert.deepEqual(page.data.items.map((i) => i.id), [1, 2]);
});

test("h 登录失败真实retry+无家庭CTA/input禁用", async () => {
  let fails = 1;
  const e1 = env({ ensureLogin: () => (fails-- > 0 ? Promise.reject(new Error("auth")) : Promise.resolve()) });
  await flush();
  assert.equal(e1.page.data.errorText, "登录失败，请重试");
  e1.page.onRetry();
  await flush();
  assert.equal(e1.calls.login, 2);
  const e2 = env({ cold: true });
  e2.store.applyMe({ id: 1 }, []);
  await e2.page.resumeAuth();
  assert.equal(e2.page.data.noFamily, true);
  assert.equal(e2.page.data.ready, false);
});

test("冷启动ensureLogin后applyMe才可加载", async () => {
  let uidBefore = -1;
  const { calls } = env({
    cold: true,
    ensureLogin: (store) => {
      uidBefore = store.user ? store.user.id : 0;
      store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
      return Promise.resolve();
    },
  });
  await flush();
  assert.equal(calls.list.length, 1);
  assert.equal(uidBefore, 0);
  assert.match(calls.list[0], /family_id=10/);
});

test("items: auth等待时reload/pull不能使鉴权frame永久失效", async () => {
  const auth = deferred();
  const e = env({ ensureLogin: () => auth.p });
  assert.equal(e.page.data.busy, true);
  await e.page.reload();
  await e.page.onPullDownRefresh();
  assert.equal(e.calls.list.length, 0);
  auth.resolve();
  await flush();
  assert.equal(e.page.data.busy, false);
  assert.equal(e.page.data.ready, true);
  assert.equal(e.calls.list.length, 1);
});

test("items: 首个debounce id0在hide时确实移除", async () => {
  const e = env();
  await ready(e.page);
  e.page.onSearchInput({ detail: { value: "尚未提交" } });
  assert.deepEqual([...e.clock.timers.keys()], [0]);
  e.page.onHide();
  assert.equal(e.clock.timers.size, 0);
  e.clock.advance(1000);
  await flush();
  assert.equal(e.calls.list.length, 1);
});

test("items: auth失败的error/retry不藏在ready结果区", () => {
  const xml = fs.readFileSync(path.join(MP_DIR, "pages/items/index.wxml"), "utf8");
  const resultBlockEnd = xml.indexOf("</block>");
  assert.ok(xml.indexOf('wx:if="{{errorText && !busy}}"') > resultBlockEnd);
});

test("快照参数family/q/page来自冻结scope", async () => {
  const { page, calls } = env();
  await ready(page);
  page.setData({ keyword: "锤子" });
  await page.reload();
  assert.match(calls.list[calls.list.length - 1], /family_id=10&q=%E9%94%A4%E5%AD%90&page=1&page_size=20/);
});
