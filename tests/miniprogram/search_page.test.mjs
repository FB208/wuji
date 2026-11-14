import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTsModule, mockWx, makePage, MP_DIR } from "./helpers/loader.mjs";

const PAGE = path.join(MP_DIR, "pages/search/index.ts");
const WXML = path.join(MP_DIR, "pages/search/index.wxml");
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

function response(context = { family_id: 10 }, ids = [1]) {
  return {
    transcript: "语音描述", status: ids.length > 1 ? "multiple" : ids.length ? "found" : "not_found",
    prompt: null, items: ids.map((id) => ({ id, name: `物品${id}`, location_text: "抽屉", image_url: `image${id}.jpg` })),
    context,
  };
}

function env(overrides = {}) {
  const calls = { text: [], audio: [], me: 0, login: 0, toasts: [], navs: [], relaunches: [], aborted: [], interrupts: 0 };
  const storage = new Map();
  const storeMod = loadTsModule(K("store/index.ts"), {
    globals: {
      wx: mockWx({
        getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
        setStorageSync: (k, v) => storage.set(k, v),
        removeStorageSync: (k) => storage.delete(k),
      }),
    },
  });
  const store = storeMod.store;
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  }
  const apiMod = {
    ApiError: class extends Error {
      constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; }
    },
    request: (o) => {
      assert.equal(o.path, "/items/search/text");
      o.onTask && o.onTask({ abort: () => calls.aborted.push("text") });
      calls.text.push(JSON.parse(JSON.stringify(o.data)));
      return overrides.request ? overrides.request(o) : Promise.resolve(response());
    },
    uploadFile: (o) => {
      assert.equal(o.path, "/items/search/audio");
      o.onTask && o.onTask({ abort: () => calls.aborted.push("audio") });
      calls.audio.push({ filePath: o.filePath, formData: JSON.parse(JSON.stringify(o.formData)) });
      return overrides.upload ? overrides.upload(o) : Promise.resolve(response());
    },
  };
  const scopeMod = loadTsModule(K("services/page-scope.ts"), {
    globals: {},
    mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod },
  });
  const wx = mockWx({
    showToast: (o) => calls.toasts.push(o.title),
    navigateTo: (o) => calls.navs.push(o.url),
    reLaunch: (o) => calls.relaunches.push(o.url),
    switchTab: (o) => calls.navs.push(o.url),
  });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin(store) : Promise.resolve(); },
    refreshMe: () => { calls.me++; return overrides.refreshMe ? overrides.refreshMe(store) : Promise.resolve({ user: store.user, families: store.families }); },
  };
  let def;
  loadTsModule(PAGE, {
    globals: { wx, Page: (d) => { def = d; } },
    mocks: {
      [K("services/api")]: apiMod,
      [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod,
      [K("store/index")]: storeMod,
    },
  });
  const page = makePage(def);
  page.onLoad();
  page.selectComponent = () => ({ interrupt: () => calls.interrupts++ });
  return { page, calls, store, apiMod };
}

async function flush(n = 40) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
async function ready(page) {
  page.onShow();
  await flush();
  assert.equal(page.data.ready, true);
}

test("1 audio拒绝后onRetry仍audio端点同filePath/family/context", async () => {
  const failed = deferred();
  let attempts = 0;
  const e = env({ upload: () => ++attempts === 1 ? failed.p : Promise.resolve(response()) });
  await ready(e.page);
  e.page.onRecordFinish({ detail: { tempFilePath: "wxfile://a.mp3" } });
  assert.equal(e.calls.audio.length, 1);
  failed.reject(new e.apiMod.ApiError({ code: "NETWORK_ERROR", message: "离线", retryable: true }));
  await flush();
  assert.equal(e.page.data.state, "error");
  assert.ok(Object.isFrozen(e.page._pending));
  assert.ok(Object.isFrozen(e.page._pending.context));
  e.page.onRetry();
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.audio.length, 2);
  assert.equal(e.calls.text.length, 0);
  assert.deepEqual(e.calls.audio[1], e.calls.audio[0]);
});

test("search: 不可重试语音错误让用户重新说而不重复坏文件", async () => {
  const failed = deferred();
  const e = env({ upload: () => failed.p });
  await ready(e.page);
  e.page.onRecordFinish({ detail: { tempFilePath: "wxfile://bad.mp3" } });
  assert.equal(e.calls.audio.length, 1);
  failed.reject(new e.apiMod.ApiError({ code: "ASR_EMPTY", message: "没听清", retryable: false }, 400));
  await flush();
  e.page.onRetry();
  await flush();
  assert.equal(e.page.data.state, "ready");
  assert.equal(e.page._pending, null);
  assert.equal(e.calls.audio.length, 1);
});

test("search: retry复用原冻结context而非变化后的视图context", async () => {
  let attempts = 0;
  const failed = deferred();
  const e = env({ request: () => ++attempts === 2 ? failed.p : Promise.resolve(response({ family_id: 10, initial_query: "最初", turns: [{ query: "白色的" }] })) });
  await ready(e.page);
  e.page.onTextInput({ detail: { value: "最初" } });
  e.page.onTextSubmit();
  await flush();
  e.page.onTextInput({ detail: { value: "短一点" } });
  e.page.onTextSubmit();
  assert.equal(e.calls.text.length, 2);
  failed.reject(new e.apiMod.ApiError({ code: "NETWORK_ERROR", message: "离线", retryable: true }));
  await flush();
  e.page.setData({ context: { family_id: 10, initial_query: "不该采用" } });
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.text.length, 3);
  assert.deepEqual(e.calls.text[2], e.calls.text[1]);
});

test("2 clear后新查询先完成、旧响应后到也不覆盖", async () => {
  const old = deferred(), latest = deferred();
  let attempt = 0;
  const { page, calls } = env({ request: () => ++attempt === 1 ? old.p : latest.p });
  await ready(page);
  page.onTextInput({ detail: { value: "old" } });
  page.onTextSubmit();
  assert.equal(calls.text.length, 1);
  page.onClear();
  assert.deepEqual(calls.aborted, ["text"]);
  assert.equal(calls.interrupts, 1);
  page.onTextInput({ detail: { value: "new" } });
  page.onTextSubmit();
  assert.equal(calls.text.length, 2);
  latest.resolve(response({ family_id: 10, initial_query: "new" }, [2]));
  await flush();
  old.resolve(response({ family_id: 10, initial_query: "old" }, [9]));
  await flush();
  assert.equal(calls.text.length, 2);
  assert.equal(page.data.context.initial_query, "new");
  assert.deepEqual(page.data.items.map((item) => item.id), [2]);
});

test("3 hide/onShow同scope不searching且retry用原pending", async () => {
  const d = deferred();
  let attempt = 0;
  const { page, calls } = env({ request: () => ++attempt === 1 ? d.p : Promise.resolve(response({ family_id: 10, initial_query: "retried" })) });
  await ready(page);
  page.setData({ textQuery: "q" });
  page.onTextSubmit();
  assert.equal(calls.text.length, 1);
  page.onHide();
  page.onShow();
  await flush();
  assert.notEqual(page.data.state, "searching");
  assert.ok(page._pending);
  page.onRetry();
  await flush();
  assert.equal(calls.text.length, 2);
  assert.deepEqual(calls.text[0], calls.text[1]);
  d.resolve(response({ family_id: 10, initial_query: "late" }));
  await flush();
  assert.equal(page.data.context.initial_query, "retried");
});

for (const uid of [1, 2]) for (const outcome of ["resolve", "reject"]) {
  test(`4 同frame UID=${uid} ${outcome}清旧内容且不自动重放`, async () => {
    const d = deferred();
    const { page, store, calls } = env({ request: () => d.p });
    await ready(page);
    page.onTextInput({ detail: { value: "旧私人查询" } });
    page.onTextSubmit();
    assert.equal(calls.text.length, 1);
    store.applyMe({ id: uid }, [{ id: 20, name: "新家", owner_user_id: uid, role: "owner" }]);
    if (outcome === "resolve") d.resolve(response({ family_id: 10 }, [9]));
    else d.reject(new Error("旧私人错误"));
    await flush();
    assert.equal(page.data.state, "ready");
    assert.equal(page.data.context, null);
    assert.deepEqual(page.data.items, []);
    assert.equal(page.data.lastQuery, "");
    assert.equal(page.data.textQuery, "");
    assert.equal(page._pending, null);
    assert.equal(calls.text.length, 1);
    assert.deepEqual(calls.toasts, []);
  });
}

test("5 登录失败后onRetry真实重试ensureLogin", async () => {
  let fails = 1;
  const { page, calls } = env({
    ensureLogin: () => (fails-- > 0 ? Promise.reject(new Error("auth")) : Promise.resolve()),
  });
  page.onShow();
  await flush();
  assert.equal(page.data.state, "error");
  page.onRetry();
  await flush();
  assert.equal(calls.login, 2);
  assert.equal(page.data.ready, true);
  page.setData({ textQuery: "q" });
  page.onTextSubmit();
  await flush();
  assert.equal(calls.text.length, 1);
});

test("6 busy鉴权期间onClear后恢复可操作", async () => {
  const d = deferred();
  const { page, calls } = env({ ensureLogin: () => d.p });
  page.onShow();
  page.onClear();
  d.resolve();
  await flush();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.ready, true);
  page.onTextInput({ detail: { value: "q" } });
  page.onTextSubmit();
  await flush();
  assert.equal(calls.text.length, 1);
});

test("7 403后refreshMe换scope清旧不重放", async () => {
  const d = deferred();
  const me = deferred();
  const { page, calls, apiMod } = env({
    request: () => d.p,
    refreshMe: (store) => {
      store.applyMe({ id: 1 }, [{ id: 20, name: "g", owner_user_id: 1, role: "member" }]);
      return me.p;
    },
  });
  await ready(page);
  page.setData({ textQuery: "q" });
  page.onTextSubmit();
  assert.equal(calls.text.length, 1);
  const err = new apiMod.ApiError({ code: "FAMILY_FORBIDDEN", message: "x", retryable: false });
  err.statusCode = 403;
  d.reject(err);
  await flush();
  assert.equal(calls.me, 1);
  me.resolve();
  await flush();
  assert.equal(page.data.state, "ready");
  assert.equal(page.data.context, null);
  assert.deepEqual(page.data.items, []);
  assert.equal(page._pending, null);
  assert.equal(calls.text.length, 1);
  assert.deepEqual(calls.toasts, []);
});

test("8 hidden后UI handlers不toast/nav/setData", async () => {
  const { page, calls } = env();
  await ready(page);
  page.onTextInput({ detail: { value: "q" } });
  page.onTextSubmit();
  await flush();
  assert.equal(page.data.items.length, 1);
  page.onHide();
  const writes = page._setDataCalls.length;
  const toastBefore = calls.toasts.length;
  const navBefore = calls.navs.length;
  page.onPermissionDenied();
  page.onRecordError({ detail: { message: "x" } });
  page.onItemTap({ detail: { item: { id: 1 } } });
  page.onTextInput({ detail: { value: "x" } });
  page.toggleTextInput();
  page.onClear();
  page.onRetry();
  page.goHome();
  page.onExclude({ currentTarget: { dataset: { id: 1 } } });
  page.onRecordFinish({ detail: { tempFilePath: "late.mp3" } });
  assert.equal(calls.toasts.length, toastBefore);
  assert.equal(calls.navs.length, navBefore);
  assert.equal(page._setDataCalls.length, writes);
  assert.equal(calls.text.length, 1);
});

test("9 完整server ctx透传+连续排除累计", async () => {
  const ctx = {
    family_id: 10, initial_query: "orig",
    turns: Array.from({ length: 6 }, (_, i) => ({ query: "q" + i, status: "found", item_ids: [i + 1] })),
    shown_item_ids: [1, 2], excluded_item_ids: [], last_item_ids: [1, 2], last_status: "multiple",
  };
  const { page, calls } = env({
    request: (o) => {
      const excluded = o.data.context.excluded_item_ids || [];
      const ids = [1, 2].filter((id) => !excluded.includes(id));
      return Promise.resolve(response({ ...ctx, excluded_item_ids: excluded }, ids));
    },
  });
  await ready(page);
  page.setData({ textQuery: "q" });
  page.onTextSubmit();
  await flush();
  assert.deepEqual(page.data.context, ctx);
  page.onTextInput({ detail: { value: "补充条件" } });
  page.onTextSubmit();
  await flush();
  assert.deepEqual(calls.text[1].context, ctx);
  page.onExclude({ currentTarget: { dataset: { id: 1 } } });
  await flush();
  page.onExclude({ currentTarget: { dataset: { id: 2 } } });
  await flush();
  assert.deepEqual(calls.text[2].context.excluded_item_ids, [1]);
  assert.deepEqual(calls.text[3].context.excluded_item_ids, [1, 2]);
  assert.deepEqual(calls.text[3].context.turns, ctx.turns);
  page.onExclude({ currentTarget: { dataset: { id: 999 } } });
  assert.equal(calls.text.length, 4);
});

test("11 513文字不发且不悄悄截断查询", async () => {
  const { page, calls } = env();
  await ready(page);
  page.onTextInput({ detail: { value: "x".repeat(513) } });
  page.onTextSubmit();
  await flush();
  assert.equal(calls.text.length, 0);
  assert.equal(page.data.textQuery.length, 513);
});

test("search: 失败后换用户，retry不能重放旧pending", async () => {
  const failed = deferred();
  const e = env({ request: () => failed.p });
  await ready(e.page);
  e.page.onTextInput({ detail: { value: "旧查询" } });
  e.page.onTextSubmit();
  assert.equal(e.calls.text.length, 1);
  failed.reject(new e.apiMod.ApiError({ code: "NETWORK_ERROR", message: "离线", retryable: true }));
  await flush();
  e.store.applyMe({ id: 2 }, [{ id: 20, name: "g", owner_user_id: 2, role: "owner" }]);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.text.length, 1);
});

test("search: 无家庭清旧内容、禁用输入并能回首页", async () => {
  const e = env();
  await ready(e.page);
  e.page.onTextInput({ detail: { value: "q" } });
  e.page.onTextSubmit();
  await flush();
  assert.equal(e.page.data.items.length, 1);
  e.store.applyMe({ id: 1 }, []);
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.noFamily, true);
  assert.equal(e.page.data.ready, false);
  assert.deepEqual(e.page.data.items, []);
  e.page.onRecordFinish({ detail: { tempFilePath: "voice" } });
  e.page.onTextInput({ detail: { value: "q" } });
  e.page.onTextSubmit();
  assert.equal(e.calls.text.length, 1);
  assert.equal(e.calls.audio.length, 0);
  e.page.goHome();
  assert.deepEqual(e.calls.navs, ["/pages/home/index"]);
});

test("search: 真冷启动在ensureLogin中改变scope后可查", async () => {
  const e = env({
    cold: true,
    ensureLogin: (store) => store.applyMe({ id: 1 }, [{ id: 10, name: "家", owner_user_id: 1, role: "owner" }]),
  });
  assert.equal(e.store.user, null);
  await ready(e.page);
  e.page.onTextInput({ detail: { value: "q" } });
  e.page.onTextSubmit();
  await flush();
  assert.equal(e.calls.text.length, 1);
  assert.equal(e.calls.text[0].family_id, 10);
  assert.equal(e.page.data.state, "found");
});

test("search: auth等待隐藏旧结果，换用户以单次setData清图再ready", async () => {
  const gate = deferred();
  let login = 0;
  const e = env({ ensureLogin: () => ++login === 1 ? Promise.resolve() : gate.p });
  await ready(e.page);
  e.page.onTextInput({ detail: { value: "私人查询" } });
  e.page.onTextSubmit();
  await flush();
  assert.equal(e.page.data.items.length, 1);
  e.page.onHide();
  e.page.onShow();
  assert.equal(e.page.data.ready, false);
  assert.equal(e.page.data.busy, true);
  e.store.applyMe({ id: 2 }, [{ id: 20 }]);
  const start = e.page._setDataCalls.length;
  gate.resolve();
  await flush();
  const updates = e.page._setDataCalls.slice(start);
  assert.ok(updates.some((update) => update.ready === true));
  for (const update of updates.filter((update) => update.ready === true)) assert.deepEqual(update.items, []);
  assert.equal(e.page.data.context, null);
  assert.equal(e.page.data.lastQuery, "");
});

test("12 WXML含exclude catchtap/disabled", () => {
  const wxml = fs.readFileSync(WXML, "utf8");
  assert.equal((wxml.match(/catchtap="onExclude"/g) || []).length, 2);
  assert.match(wxml, /disabled="\{\{busy \|\| !ready/);
  assert.match(wxml, /wx:if="\{\{busy\}\}"/);
  assert.match(wxml, /wx:elif="\{\{!ready\}\}"/);
  assert.doesNotMatch(wxml, /bind:recordstart/);
});
