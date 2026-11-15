import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, makePage, MP_DIR } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const HOME = path.join(MP_DIR, "pages/home/index.js");
const PROF = path.join(MP_DIR, "pages/profile/index.js");
const FLIST = path.join(MP_DIR, "pages/family-list/index.js");
function deferred() { let r; const p = new Promise((res) => { r = res; }); return { p, resolve: r }; }
async function flush(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function env(overrides = {}, pagePath = HOME) {
  const calls = { list: [], login: 0, navs: [], relaunches: [], switchTab: [], stopPull: 0, post: [], modals: [] };
  const storage = new Map();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    showToast: () => {},
    navigateTo: (o) => calls.navs.push(o.url),
    navigateBack: () => { calls.navs.push("back"); },
    reLaunch: (o) => calls.relaunches.push(o.url),
    switchTab: (o) => calls.switchTab.push(o.url),
    stopPullDownRefresh: () => { calls.stopPull++; },
    showModal: (o) => { calls.modals.push(o); if (overrides.modal) overrides.modal(o); },
  });
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  }
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
    request: (o) => {
      if (o.path === "/families") { calls.post.push(JSON.parse(JSON.stringify(o.data))); return overrides.post ? overrides.post(o) : Promise.resolve({ id: 99 }); }
      calls.list.push(o.path);
      return overrides.request ? overrides.request(o) : Promise.resolve({ items: [{ id: 1, name: "a", updated_at: 0 }], total: 1 });
    },
  };
  const scopeMod = loadModule(K("services/page-scope.js"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin() : Promise.resolve(); },
    refreshMe: (skip, pref) => { store.applyMe(store.user || { id: 1 }, store.families.length ? store.families : [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }], pref); return Promise.resolve({ user: store.user, families: store.families }); },
  };
  let def;
  loadModule(pagePath, {
    globals: { wx: wxBase, Page: (d) => { def = d; } },
    mocks: {
      [K("services/api")]: apiMod,
      [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod,
      [K("store/index")]: storeMod,
      [K("utils/format")]: { formatTime: (t) => "t" + t },
    },
  });
  const page = makePage(def);
  page.onLoad();
  page.onShow();
  return { page, calls, store, apiMod };
}

test("1 home冷启动后可显示", async () => {
  const { page, calls, store } = env({ cold: true }, HOME);
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  page.onShow();
  await flush();
  assert.equal(page.data.ready, true);
  assert.equal(calls.list.length >= 1, true);
  assert.match(calls.list[0], /family_id=10&page=1&page_size=3/);
});
test("2 pending recent换family不写", async () => {
  const d = deferred();
  const { page, store, calls } = env({ request: () => d.p }, HOME);
  await flush(3);
  assert.equal(calls.list.length, 1);
  store.applyMe({ id: 1 }, [{ id: 20, name: "g", owner_user_id: 1, role: "member" }]);
  d.resolve({ items: [{ id: 9, name: "old", updated_at: 0 }] });
  await flush();
  assert.equal(page.data.recentItems.length, 0);
});
test("3 auth前旧UI清空", async () => {
  const { page } = env({}, HOME);
  page.setData({ familyName: "old", recentItems: [{ id: 1 }] });
  page.onShow();
  assert.equal(page.data.familyName, "");
  assert.equal(page.data.recentItems.length, 0);
});
test("4 auth失败真实retry", async () => {
  let fails = 1;
  const { page, calls } = env({ ensureLogin: () => (fails-- > 0 ? Promise.reject(new Error("x")) : Promise.resolve()) }, HOME);
  await flush();
  assert.equal(page.data.errorText, "登录失败，请重试");
  page.onRetry();
  await flush();
  assert.equal(calls.login, 2);
});
test("5 无family归零且0 itemsGET", async () => {
  const { page, calls, store } = env({}, HOME);
  store.applyMe({ id: 1 }, []);
  await page.activate();
  assert.equal(calls.list.length, 0);
  assert.equal(page.data.recentItems.length, 0);
  assert.equal(page.data.noFamily, true);
});
test("6 selector全部8组可点ID80", async () => {
  const { page, store, calls } = env({}, FLIST);
  store.applyMe({ id: 1 }, Array.from({ length: 8 }, (_, i) => ({ id: (i + 1) * 10, name: "f" + i, owner_user_id: 1, role: "owner" })));
  await page.activate();
  assert.equal(page.data.rows.length, 8);
  page.onPick({ currentTarget: { dataset: { id: 80 } } });
  assert.equal(store.currentFamilyId, 80);
});
test("7 隐藏后选择不导航/不改store", async () => {
  const { page, store, calls } = env({}, FLIST);
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  await flush();
  await page.activate();
  page.onHide();
  const navBefore = calls.navs.length;
  page.onPick({ currentTarget: { dataset: { id: 10 } } });
  assert.equal(calls.navs.length, navBefore);
});
test("10 hidden后callbacks不写", async () => {
  const { page, calls } = env({}, HOME);
  await flush();
  page.onHide();
  const setDataBefore = (page._setDataCalls || []).length;
  page.onItemTap({ detail: { item: { id: 1 } } });
  page.onSwitchFamily();
  assert.equal((page._setDataCalls || []).length, setDataBefore);
});
test("11 pullDown旧op不stop别页spinner", async () => {
  const d = deferred();
  const { page, calls } = env({ request: () => d.p }, HOME);
  await flush(3);
  assert.equal(calls.list.length, 1);
  page.onHide();
  await page.onPullDownRefresh();
  d.resolve({ items: [] });
  await flush();
  assert.equal(calls.stopPull, 0);
});
