import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTsModule, mockWx, makePage, MP_DIR } from "./helpers/loader.mjs";

const K = (p) => MP_DIR.replaceAll(path.sep, "/") + "/" + p;
const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
const family = (id = 10, uid = 1) => ({ id, name: `家庭${id}`, owner_user_id: uid, role: "owner" });
const user = (id = 1) => ({ id, nickname: `用户${id}`, avatar_url: `avatar-${id}` });
const item = (id) => ({ id, name: `物品${id}`, image_url: `photo-${id}`, location_text: "抽屉", updated_at: "2026-01-01T00:00:00Z" });
const deferred = () => {
  let resolve, reject;
  const p = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { p, resolve, reject };
};
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

function env(pageName = "profile", options = {}) {
  const calls = { get: [], post: [], login: 0, me: [], modal: [], toast: [], nav: [], stop: 0, abort: [] };
  const storage = new Map();
  const wx = mockWx({
    getStorageSync: (k) => storage.has(k) ? clone(storage.get(k)) : "",
    setStorageSync: (k, v) => storage.set(k, clone(v)),
    removeStorageSync: (k) => storage.delete(k),
    showModal: (o) => calls.modal.push(o),
    showToast: (o) => calls.toast.push(o.title),
    navigateTo: (o) => calls.nav.push(o.url),
    switchTab: (o) => calls.nav.push(o.url),
    reLaunch: (o) => calls.nav.push(o.url),
    navigateBack: () => calls.nav.push("back"),
    stopPullDownRefresh: () => calls.stop++,
  });
  const sm = loadTsModule(K("store/index.ts"), { globals: { wx } });
  const store = sm.store;
  if (!options.cold) store.applyMe(user(), [family()]);
  const api = {
    ApiError: class extends Error {
      constructor(body, status = 0) {
        super(body.message);
        this.code = body.code;
        this.retryable = body.retryable;
        this.statusCode = status;
      }
    },
    request: (o) => {
      if (o.onTask) o.onTask({ abort: () => calls.abort.push(o.path) });
      if (o.path === "/families") {
        calls.post.push(clone({ method: o.method, data: o.data }));
        return options.post ? options.post(o) : Promise.resolve({ id: 99 });
      }
      calls.get.push(o.path);
      return options.get ? options.get(o) : Promise.resolve({ items: [item(1)], total: 23 });
    },
  };
  const gm = loadTsModule(K("services/page-scope.ts"), {
    mocks: { [K("services/api")]: api, [K("store/index")]: sm },
  });
  let definition;
  loadTsModule(K(`pages/${pageName}/index.ts`), {
    globals: { wx, Page: (d) => { definition = d; }, getCurrentPages: () => options.singlePage ? [] : [{}, {}] },
    mocks: {
      [K("services/api")]: api,
      [K("services/page-scope")]: gm,
      [K("store/index")]: sm,
      [K("utils/format")]: { formatTime: (v) => v },
      [K("services/auth")]: {
        ensureLogin: () => { calls.login++; return options.login ? options.login(store) : Promise.resolve(); },
        refreshMe: (skip, preferred) => {
          calls.me.push([skip, preferred]);
          if (options.me) return options.me(store, preferred);
          store.applyMe(user(), preferred ? [family(), family(preferred)] : [family(20)], preferred);
          return Promise.resolve();
        },
      },
    },
  });
  const page = makePage(definition);
  page.onLoad();
  return { page, calls, store, api };
}
async function boot(e) { e.page.onShow(); await flush(); }
async function confirm(e, name = " 新家庭 ") {
  e.page.onCreateFamily();
  assert.equal(e.calls.modal.length, 1);
  return e.calls.modal[0].success({ confirm: true, content: name });
}

for (const name of ["home", "profile"]) {
  test(`${name}: 真实cold由ensureLogin建立scope后发正确GET`, async () => {
    let before = -1;
    const e = env(name, { cold: true, login: (store) => {
      before = store.user ? store.user.id : 0;
      store.applyMe(user(), [family()]);
      return Promise.resolve();
    } });
    await boot(e);
    assert.equal(before, 0);
    assert.equal(e.calls.get.length, 1);
    assert.equal(e.calls.get[0], `/items?family_id=10&page=1&page_size=${name === "home" ? 3 : 1}`);
    assert.equal(e.page.data.ready, true);
    if (name === "profile") assert.equal(e.page.data.itemCount, 23);
  });
  test(`${name}: auth失败真实retry且先清已展示的旧信息`, async () => {
    let fail = false;
    const e = env(name, { login: () => fail ? Promise.reject(new Error("离线")) : Promise.resolve() });
    await boot(e);
    if (name === "home") assert.equal(e.page.data.recentItems.length, 1);
    else assert.equal(e.page.data.avatarUrl, "avatar-1");
    fail = true;
    e.page.onShow();
    assert.equal(e.page.data.familyName, "");
    if (name === "home") assert.deepEqual(e.page.data.recentItems, []);
    else assert.equal(e.page.data.avatarUrl, "");
    await flush();
    assert.equal(e.page.data.ready, false);
    assert.ok(e.page.data.errorText);
    fail = false;
    e.page.onRetry();
    await flush();
    assert.equal(e.calls.login, 3);
    assert.equal(e.page.data.ready, true);
  });
  test(`${name}: noFamily不GET且创建加入入口有效`, async () => {
    const e = env(name, { cold: true, login: (store) => { store.applyMe(user(), []); return Promise.resolve(); } });
    await boot(e);
    assert.equal(e.calls.get.length, 0);
    assert.equal(e.page.data.noFamily, true);
    if (name === "home") {
      e.page.goSearch();
      await e.page.onPullDownRefresh();
      assert.deepEqual(e.calls.nav, ["/pages/profile/index"]);
      assert.equal(e.calls.get.length, 0);
      assert.equal(e.calls.stop, 1);
    } else {
      assert.equal(e.page.data.itemCount, 0);
      e.page.onHowToJoin();
      assert.match(e.calls.modal[0].content, /邀请卡片/);
      e.page.onCreateFamily();
      assert.equal(e.calls.modal[1].editable, true);
    }
  });
  for (const uid of [1, 2]) for (const outcome of ["resolve", "reject"]) {
    test(`${name}: pending ${outcome}在UID=${uid}换scope后不回写旧数据`, async () => {
      const d = deferred();
      const e = env(name, { get: () => d.p });
      await boot(e);
      assert.equal(e.calls.get.length, 1);
      e.store.applyMe(user(uid), [family(20, uid)]);
      if (outcome === "resolve") d.resolve({ items: [item(9)], total: 999 });
      else d.reject(new Error("旧账号错误"));
      await flush();
      assert.equal(e.page.data.familyName, "");
      assert.equal(e.page.data.ready, false);
      if (name === "profile") {
        assert.equal(e.page.data.nickname, "");
        assert.equal(e.page.data.avatarUrl, "");
        assert.equal(e.page.data.itemCount, null);
      } else assert.deepEqual(e.page.data.recentItems, []);
      assert.deepEqual(e.calls.toast, []);
      assert.equal(e.calls.get.length, 1);
    });
  }
}

for (const change of ["family", "uid"]) {
  test(`profile: modal打开后换${change}再confirm不POST`, async () => {
    const e = env();
    await boot(e);
    e.page.onCreateFamily();
    e.store.applyMe(user(change === "uid" ? 2 : 1), [family(20, change === "uid" ? 2 : 1)]);
    await e.calls.modal[0].success({ confirm: true, content: "不应创建" });
    assert.equal(e.calls.post.length, 0);
  });
}

test("profile: 创建后Me原子选中+Count完成才解busy，合法新scope能toast", async () => {
  const count = deferred();
  let gets = 0;
  const e = env("profile", { get: () => ++gets === 1 ? Promise.resolve({ total: 23 }) : count.p });
  await boot(e);
  e.page.onCreateFamily();
  const callback = e.calls.modal[0].success;
  const done = callback({ confirm: true, content: " 新家 " });
  callback({ confirm: true, content: " 新家 " });
  await flush();
  assert.deepEqual(e.calls.post, [{ method: "POST", data: { name: "新家" } }]);
  assert.deepEqual(e.calls.me, [[false, 99]]);
  assert.equal(e.store.currentFamilyId, 99);
  assert.equal(e.store.families.length, 2);
  assert.equal(e.page.data.familyName, "家庭99");
  assert.equal(e.page.data.itemCount, null);
  assert.equal(e.page.data.busy, true);
  assert.equal(e.calls.get[1], "/items?family_id=99&page=1&page_size=1");
  count.resolve({ total: 7 });
  await done;
  assert.equal(e.page.data.itemCount, 7);
  assert.equal(e.page.data.busy, false);
  assert.deepEqual(e.calls.toast, ["已创建"]);
});

for (const stage of ["post", "me", "count"]) for (const action of ["uid", "hide"]) {
  test(`profile: ${stage} pending时${action}不回写/不toast/不解新操作busy`, async () => {
    const d = deferred();
    let gets = 0;
    const e = env("profile", {
      post: () => stage === "post" ? d.p : Promise.resolve({ id: 99 }),
      me: (store, preferred) => {
        if (stage === "me") return d.p;
        store.applyMe(user(), [family(), family(preferred)], preferred);
        return Promise.resolve();
      },
      get: () => stage === "count" && ++gets > 1 ? d.p : Promise.resolve({ total: 23 }),
    });
    await boot(e);
    const done = confirm(e);
    await flush();
    assert.equal(e.calls.post.length, 1);
    if (stage !== "post") assert.equal(e.calls.me.length, 1);
    if (stage === "count") assert.equal(e.calls.get.length, 2);
    if (action === "uid") e.store.applyMe(user(2), [family(20, 2)]);
    else e.page.onHide();
    const start = e.page._setDataCalls.length;
    d.resolve(stage === "post" ? { id: 99 } : stage === "count" ? { total: 999 } : undefined);
    await done;
    await flush();
    assert.deepEqual(e.calls.toast, []);
    if (action === "hide") assert.equal(e.page._setDataCalls.length, start);
    else {
      assert.equal(e.page.data.nickname, "");
      assert.notEqual(e.store.currentFamilyId, 99);
    }
    if (stage === "post") assert.equal(e.calls.me.length, 0);
  });
}

test("home: 两次pull失序，旧response与旧stop不覆盖新spinner/数据", async () => {
  const a = deferred(), b = deferred();
  let gets = 0;
  const e = env("home", { get: () => ++gets === 1 ? Promise.resolve({ items: [] }) : gets === 2 ? a.p : b.p });
  await boot(e);
  const first = e.page.onPullDownRefresh();
  assert.equal(e.calls.get.length, 2);
  const second = e.page.onPullDownRefresh();
  assert.equal(e.calls.get.length, 3);
  a.resolve({ items: [item(8)] });
  await first;
  assert.equal(e.calls.stop, 0);
  assert.deepEqual(e.page.data.recentItems, []);
  b.resolve({ items: [item(9)] });
  await second;
  assert.equal(e.calls.stop, 1);
  assert.equal(e.page.data.recentItems[0].id, 9);
});

test("family-list: 完整8组选80真实导航，旧scope和hide无动作", async () => {
  const e = env("family-list", { cold: true, login: (store) => {
    store.applyMe(user(), Array.from({ length: 8 }, (_, i) => family((i + 1) * 10)));
    return Promise.resolve();
  } });
  await boot(e);
  assert.equal(e.page.data.rows.length, 8);
  e.page.onPick({ currentTarget: { dataset: { id: 80 } } });
  assert.equal(e.store.currentFamilyId, 80);
  assert.deepEqual(e.calls.nav, ["back"]);
  e.page.onShow();
  await flush();
  e.store.applyMe(user(2), [family(20, 2)]);
  e.page.onPick({ currentTarget: { dataset: { id: 10 } } });
  e.page.onHide();
  e.page.goProfile();
  assert.equal(e.store.currentFamilyId, 20);
  assert.deepEqual(e.calls.nav, ["back"]);
});

test("profile: hidden所有交互零UI动作，模板有真实加入入口及未知计数占位", async () => {
  const e = env();
  await boot(e);
  e.page.onHide();
  const start = e.page._setDataCalls.length;
  for (const fn of ["onCreateFamily", "onHowToJoin", "onPrivacy", "onFeedback", "onSwitchFamily", "goFamily", "onRetry"]) e.page[fn]();
  assert.equal(e.page._setDataCalls.length, start);
  assert.deepEqual(e.calls.modal, []);
  assert.deepEqual(e.calls.nav, []);
  assert.deepEqual(e.calls.toast, []);
  const xml = fs.readFileSync(path.join(MP_DIR, "pages/profile/index.wxml"), "utf8");
  assert.match(xml, /bindtap="onHowToJoin"/);
  assert.match(xml, /itemCount === null/);
});
