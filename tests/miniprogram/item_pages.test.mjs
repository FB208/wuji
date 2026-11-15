import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadModule, mockWx, makePage, MP_DIR, noticeMock } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const DT = path.join(MP_DIR, "pages/item-detail/index.js");
const ED = path.join(MP_DIR, "pages/item-edit/index.js");
function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function makeClock() {
  const timers = new Map(); let seq = 0; let now = 0;
  return { timers,
    setTimeout: (cb, ms) => { const id = seq++; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) { now += ms; let r = true; while (r) { r = false; for (const [id, t] of Array.from(timers).sort((a, b) => a[1].due - b[1].due)) if (t.due <= now) { timers.delete(id); r = true; t.cb(); } } } };
}
function env(overrides = {}, query = { id: "5" }, pagePath = DT) {
  const calls = { get: [], post: [], del: [], upload: [], login: 0, me: 0, toasts: [], navs: [], backs: [], modals: [], tabs: [], launches: [], aborts: [] };
  const storage = new Map();
  const clock = makeClock();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? JSON.parse(JSON.stringify(storage.get(k))) : ""),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: (k) => storage.delete(k),
    showToast: (o) => calls.toasts.push(o.title),
    navigateTo: (o) => calls.navs.push(o.url),
    navigateBack: () => { calls.backs.push(1); },
    switchTab: (o) => calls.tabs.push(o.url),
    reLaunch: (o) => calls.launches.push(o.url),
    previewImage: () => {},
    showModal: (o) => { calls.modals.push(o); if (overrides.modal) overrides.modal(o); },
    chooseMedia: (o) => { if (overrides.chooseMedia) overrides.chooseMedia(o); },
  });
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  }
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
    request: (o) => {
      if (o.onTask) o.onTask({ abort: () => calls.aborts.push(o.path) });
      if (o.method === "DELETE") { calls.del.push(o.path); return overrides.del ? overrides.del(o) : Promise.resolve({}); }
      if (o.method === "POST") { calls.post.push({ path: o.path, body: JSON.parse(JSON.stringify(o.data)) }); return overrides.post ? overrides.post(o) : Promise.resolve({}); }
      calls.get.push(o.path);
      return overrides.request ? overrides.request(o) : Promise.resolve({ id: 5, name: "a", location_text: "l", record_text: "r", image_url: "u", version: 7, updated_at: 0 });
    },
  };
  const scopeMod = loadModule(K("services/page-scope.js"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin(store) : Promise.resolve(); },
    refreshMe: () => { calls.me++; return overrides.refreshMe ? overrides.refreshMe(store) : Promise.resolve({ user: store.user, families: store.families }); },
  };
  const uploadMod = { uploadImage: (fid, p, opts) => {
    calls.upload.push({ fid, p });
    if (opts.onTask) opts.onTask({ abort: () => calls.aborts.push("upload") });
    return overrides.upload ? overrides.upload({ fid, p, opts }) : Promise.resolve({ image_token: "tok1" });
  } };
  let def;
  loadModule(pagePath, {
    globals: { wx: wxBase, Page: (d) => { def = d; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, getCurrentPages: () => overrides.singlePage ? [] : [{}, {}] },
    mocks: {
      [K("services/api")]: apiMod, [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod, [K("store/index")]: storeMod,
      [K("utils/format")]: { formatTime: (t) => "t" + t },
      [K("services/upload")]: uploadMod,
      [K("services/notice")]: noticeMock(wxBase),
    },
  });
  const page = makePage(def);
  page.onLoad(query);
  return { page, calls, store, apiMod, clock };
}
async function boot(e) { e.page.onShow(); await flush(); }
async function readyDetail(e) {
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.ready, true);
  assert.equal(e.page._loaded.version, 7);
}
async function readyEdit(e) {
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.loaded, true);
  assert.equal(e.page._loaded.version, 7);
}

test("cold detail可加载+version7 ready", async () => {
  const e = env({ cold: true, ensureLogin: (s) => { s.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]); return Promise.resolve(); } }, { id: "5" }, DT);
  e.page.onShow();
  await flush();
  assert.equal(e.calls.get.length, 1);
  assert.match(e.calls.get[0], /family_id=10/);
  assert.equal(e.page._loaded.version, 7);
});
test("invalid id/非法fid 0auth0GET", async () => {
  for (const q of [{ id: "abc" }, { id: "5", family_id: "-1" }]) {
    const e = env({}, q, DT);
    e.page.onShow();
    await flush();
    assert.equal(e.calls.login, 0);
    assert.equal(e.calls.get.length, 0);
  }
});
test("nofam 0GET+CTA", async () => {
  const e = env({ cold: true, ensureLogin: (s) => { s.applyMe({ id: 1 }, []); return Promise.resolve(); } }, { id: "5" }, DT);
  e.page.onShow();
  await flush();
  assert.equal(e.calls.get.length, 0);
  assert.equal(e.page.data.ready, false);
});
test("DELETE URL真带expected_version=7", async () => {
  const e = env({}, { id: "5" }, DT);
  await readyDetail(e);
  e.page.onDelete();
  assert.equal(e.calls.modals.length, 1);
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 1);
  assert.match(e.calls.del[0], /items\/5\?family_id=10&expected_version=7/);
});
test("modal开后换UID confirm 0DELETE", async () => {
  const e = env({}, { id: "5" }, DT);
  await readyDetail(e);
  e.page.onDelete();
  e.store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 0);
});
test("双confirm/双save单写", async () => {
  const e = env({}, { id: "5" }, DT);
  await readyDetail(e);
  e.page.onDelete();
  await e.calls.modals[0].success({ confirm: true });
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 1);
  const e2 = env({}, { id: "5", family_id: "10" }, ED);
  await readyEdit(e2);
  e2.page.setData({ name: "n", locationText: "l" });
  e2.page.onSave();
  e2.page.onSave();
  await flush();
  assert.equal(e2.calls.post.length, 1);
});
test("409→needsRefresh reload GET v9", async () => {
  let reads = 0;
  const e = env({
    post: () => Promise.reject(new e.apiMod.ApiError({ code: "VERSION_CONFLICT", message: "x", retryable: false }, 409)),
    request: () => Promise.resolve({ id: 5, name: ++reads === 1 ? "a" : "服务器新名称", location_text: "l", record_text: "r", image_url: "u", version: reads === 1 ? 7 : 9, updated_at: 0 }),
  }, { id: "5", family_id: "10" }, ED);
  await readyEdit(e);
  e.page.onNameInput({ detail: { value: "旧草稿" } });
  await e.page.onSave();
  await flush();
  assert.equal(e.page.data.needsRefresh, true);
  assert.match(e.page.data.errorText, /家人已修改/);
  assert.equal(e.calls.post.length, 1);
  await e.page.onSave();
  assert.equal(e.calls.post.length, 1);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.get.length, 2);
  assert.equal(e.page._loaded.version, 9);
  assert.equal(e.page.data.name, "服务器新名称");
  assert.equal(e.page.data.needsRefresh, false);
});
test("unknown POST→needsRefresh reload才可编辑", async () => {
  const e = env({ post: () => Promise.reject(new Error("net")) }, { id: "5", family_id: "10" }, ED);
  await readyEdit(e);
  e.page.setData({ name: "n", locationText: "l" });
  e.page.onSave();
  await flush();
  assert.equal(e.page.data.needsRefresh, true);
  e.page.onSave();
  await flush();
  assert.equal(e.calls.post.length, 1);
});
test("hide during GET 0setData", async () => {
  const d = deferred();
  const e = env({ request: () => d.p }, { id: "5" }, DT);
  e.page.onShow();
  await flush(3);
  e.page.onHide();
  const sd = (e.page._setDataCalls || []).length;
  d.resolve({ id: 5, name: "a", location_text: "", record_text: "", image_url: "", version: 7, updated_at: 0 });
  await flush();
  assert.equal((e.page._setDataCalls || []).length, sd);
});
test("同scope hide/show draft保留", async () => {
  const e = env({}, { id: "5", family_id: "10" }, ED);
  await readyEdit(e);
  e.page.setData({ name: "draft-x" });
  e.page.onHide();
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.name, "draft-x");
});
test("错响应id/version拒写", async () => {
  for (const bad of [{ id: 99, version: 7 }, { id: 5, version: "x" }]) {
    const e = env({ request: () => Promise.resolve({ id: bad.id, name: "a", location_text: "", record_text: "", image_url: "", version: bad.version, updated_at: 0 }) }, { id: "5" }, DT);
    e.page.onShow();
    await flush();
    assert.equal(e.page.data.item, null);
  }
});
test("POST body expected_version=7 token null", async () => {
  const e = env({}, { id: "5", family_id: "10" }, ED);
  await readyEdit(e);
  e.page.setData({ name: "n", locationText: "l" });
  e.page.onSave();
  await flush();
  assert.equal(e.calls.post[0].body.expected_version, 7);
  assert.equal(e.calls.post[0].body.image_token, null);
});
test("saved/deleted终态重复0请求", async () => {
  const e = env({}, { id: "5" }, DT);
  await readyDetail(e);
  e.page.onDelete();
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.page.data.deleted, true);
  e.page.onDelete();
  await flush();
  assert.equal(e.calls.del.length, 1);
});
test("删除确认后立即返回", async () => {
  const e = env({}, { id: "5" }, DT);
  await readyDetail(e);
  const p = e.page.onDelete();
  e.calls.modals[0].success({ confirm: true });
  await p;
  assert.equal(e.calls.backs.length, 1);
});

const record = (version = 7, fields = {}) => ({
  id: 5, name: "a", location_text: "l", record_text: "r",
  image_url: "u", version, updated_at: 0, ...fields,
});
function changeScope(e, uid = 1, fid = 20) {
  e.store.applyMe({ id: uid }, [{ id: fid, name: "新家庭", owner_user_id: uid, role: "owner" }]);
}
function input(e, value = "新名称") {
  e.page.onNameInput({ detail: { value } });
}
function choose(e, picker, name = "photo-1") {
  e.page.retakePhoto();
  assert.equal(typeof picker.current.success, "function");
  picker.current.success({ tempFiles: [{ tempFilePath: name }] });
}

for (const p of [DT, ED]) {
  test(`${path.basename(path.dirname(p))}: 真cold scope在auth中建立`, async () => {
    let before;
    const e = env({ cold: true, ensureLogin: (s) => {
      before = s.user;
      s.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
      return Promise.resolve();
    } }, { id: "5" }, p);
    await boot(e);
    assert.equal(before, null);
    assert.equal(e.calls.get.length, 1);
    assert.equal(e.page._loaded.version, 7);
    assert.notEqual(e.store.captureScope().version, 7);
  });
  test(`${path.basename(path.dirname(p))}: auth失败清完整展示并真实retry`, async () => {
    let fail = false;
    const e = env({ ensureLogin: () => fail ? Promise.reject(new Error("离线")) : Promise.resolve() }, { id: "5" }, p);
    await boot(e);
    if (p === ED) input(e, "保留的草稿");
    fail = true;
    e.page.onShow();
    if (p === DT) assert.equal(e.page.data.item, null);
    else for (const key of ["name", "recordText", "imageUrl", "newPhotoPath"]) assert.equal(e.page.data[key], "");
    await flush();
    assert.equal(e.page.data.ready, false);
    assert.equal(e.page.data.busy, false);
    fail = false;
    e.page.onRetry();
    await flush();
    assert.equal(e.calls.login, 3);
    assert.equal(e.page.data.ready, true);
    if (p === ED) {
      assert.equal(e.page.data.name, "保留的草稿");
      assert.equal(e.page.data.imageUrl, "u");
      assert.equal(e.page.data.recordText, "r");
      assert.equal(e.calls.get.length, 1);
    }
  });
  for (const uid of [1, 2]) for (const outcome of ["resolve", "reject"]) {
    test(`${path.basename(path.dirname(p))}: GET已发后uid=${uid} scope变化 ${outcome}隔离`, async () => {
      const d = deferred();
      const e = env({ request: () => d.p }, { id: "5" }, p);
      await boot(e);
      assert.equal(e.calls.get.length, 1);
      changeScope(e, uid, uid === 2 ? 10 : 20);
      if (outcome === "resolve") d.resolve(record(7, { name: "旧响应" }));
      else d.reject(new Error("旧请求错误"));
      await flush();
      assert.equal(e.page.data.ready, false);
      assert.equal(e.page.data.busy, false);
      assert.equal(e.page._loaded, null);
      if (p === ED) assert.equal(e.page.data.name, "");
      else assert.equal(e.page.data.item, null);
      e.page.onRetry();
      await flush();
      assert.equal(e.calls.get.length, 1);
      assert.deepEqual(e.calls.toasts, []);
    });
  }
  test(`${path.basename(path.dirname(p))}: 换UID但同共享family也不能复用旧intent`, async () => {
    const e = env({}, { id: "5" }, p);
    await boot(e);
    changeScope(e, 2, 10);
    e.page.onShow();
    await flush();
    assert.equal(e.page.data.blocked, true);
    assert.equal(e.calls.get.length, 1);
    assert.equal(e.page.data.ready, false);
  });
  test(`${path.basename(path.dirname(p))}: hide取消真实NativeTask且旧GET零UI写`, async () => {
    const d = deferred();
    const e = env({ request: () => d.p }, { id: "5" }, p);
    await boot(e);
    assert.equal(e.calls.get.length, 1);
    e.page.onHide();
    const count = e.page._setDataCalls.length;
    assert.equal(e.calls.aborts.length, 1);
    d.resolve(record());
    await flush();
    assert.equal(e.page._setDataCalls.length, count);
    assert.deepEqual(e.calls.toasts, []);
  });
}

test("edit: upload成功POST未知不重传，明确GET8确认后才可编辑", async () => {
  const picker = {};
  let reads = 0;
  const e = env({
    chooseMedia: (o) => { picker.current = o; },
    request: () => Promise.resolve(++reads === 1 ? record() : record(8, { name: "已写入名称" })),
    post: () => Promise.reject(new Error("响应丢失")),
  }, { id: "5" }, ED);
  await readyEdit(e);
  input(e, "已写入名称");
  choose(e, picker);
  await e.page.onSave();
  assert.equal(e.calls.upload.length, 1);
  assert.deepEqual(e.calls.upload[0], { fid: 10, p: "photo-1" });
  assert.equal(e.calls.post[0].body.image_token, "tok1");
  assert.equal(e.page.data.needsRefresh, true);
  assert.match(e.page.data.errorText, /未确认/);
  input(e, "不应修改");
  assert.equal(e.page.data.name, "已写入名称");
  await e.page.onSave();
  assert.equal(e.calls.post.length, 1);
  assert.equal(e.calls.upload.length, 1);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.get.length, 2);
  assert.equal(e.page._loaded.version, 8);
  assert.equal(e.page.data.newPhotoPath, "");
  assert.equal(e.page.data.needsRefresh, false);
  assert.equal(e.calls.post.length, 1);
});

test("edit: upload未POST失败保留照片，retry只补upload不GET丢草稿", async () => {
  const picker = {};
  let uploads = 0;
  const e = env({
    chooseMedia: (o) => { picker.current = o; },
    upload: () => ++uploads === 1 ? Promise.reject(new Error("上传失败")) : Promise.resolve({ image_token: "tok2" }),
  }, { id: "5" }, ED);
  await readyEdit(e);
  choose(e, picker);
  await e.page.onSave();
  assert.equal(e.calls.post.length, 0);
  assert.equal(e.page.data.needsRefresh, false);
  assert.equal(e.page.data.newPhotoPath, "photo-1");
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.get.length, 1);
  assert.equal(e.calls.upload.length, 2);
  assert.equal(e.calls.post.length, 1);
  assert.equal(e.calls.post[0].body.image_token, "tok2");
});

for (const stage of ["upload", "post"]) {
  test(`edit: ${stage} pending hide零迟到写，show不残留saving死锁`, async () => {
    const d = deferred(), picker = {};
    const e = env({
      chooseMedia: (o) => { picker.current = o; },
      upload: () => stage === "upload" ? d.p : Promise.resolve({ image_token: "tok1" }),
      post: () => d.p,
    }, { id: "5" }, ED);
    await readyEdit(e);
    if (stage === "upload") choose(e, picker);
    const pending = e.page.onSave();
    assert.equal(stage === "upload" ? e.calls.upload.length : e.calls.post.length, 1);
    e.page.onHide();
    const count = e.page._setDataCalls.length;
    d.resolve(stage === "upload" ? { image_token: "late" } : {});
    await pending;
    assert.equal(e.page._setDataCalls.length, count);
    assert.deepEqual(e.calls.toasts, []);
    e.page.onShow();
    await flush();
    assert.equal(e.page.data.saving, false);
    assert.equal(e.page.data.busy, false);
    assert.equal(e.page.data.needsRefresh, stage === "post");
    assert.equal(e.calls.post.length, stage === "post" ? 1 : 0);
  });
}

test("edit: 旧POST回调不能清hide/show后第二pending save", async () => {
  const old = deferred(), latest = deferred();
  let writes = 0;
  const e = env({ post: () => ++writes === 1 ? old.p : latest.p }, { id: "5" }, ED);
  await readyEdit(e);
  const first = e.page.onSave();
  assert.equal(e.calls.post.length, 1);
  e.page.onHide();
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.needsRefresh, true);
  e.page.onRetry();
  await flush();
  assert.equal(e.calls.get.length, 2);
  input(e, "第二次明确修改");
  const second = e.page.onSave();
  assert.equal(e.calls.post.length, 2);
  old.reject(new Error("旧请求失败"));
  await first;
  assert.equal(e.page.data.saving, true);
  assert.equal(e.page.data.busy, true);
  latest.resolve({});
  await second;
  assert.equal(e.page.data.saved, true);
  assert.deepEqual(e.calls.toasts, ["已保存"]);
  e.page.onHide();
});

test("edit: picker回调经hide/show往返仍写入", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } }, { id: "5" }, ED);
  await readyEdit(e);
  e.page.retakePhoto();
  e.page.onHide();
  e.page.onShow();
  await flush();
  picker.current.success({ tempFiles: [{ tempFilePath: "late-photo" }] });
  assert.equal(e.page.data.newPhotoPath, "late-photo");
});
test("edit: picker回调早于onShow写入且恢复后保留", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } }, { id: "5" }, ED);
  await readyEdit(e);
  e.page.retakePhoto();
  e.page.onHide();
  picker.current.success({ tempFiles: [{ tempFilePath: "early-photo" }] });
  assert.equal(e.page.data.newPhotoPath, "early-photo");
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.newPhotoPath, "early-photo");
});
test("edit: picker回调在scope变化后不写", async () => {
  const picker = {};
  const e = env({ chooseMedia: (o) => { picker.current = o; } }, { id: "5" }, ED);
  await readyEdit(e);
  e.page.retakePhoto();
  changeScope(e);
  const count = e.page._setDataCalls.length;
  picker.current.success({ tempFiles: [{ tempFilePath: "late-photo" }] });
  assert.equal(e.page._setDataCalls.length, count);
  assert.equal(e.page.data.newPhotoPath, "");
});

test("detail: DELETE pending hide零写，show GET恢复不残留deleting", async () => {
  const d = deferred();
  const e = env({ del: () => d.p });
  await readyDetail(e);
  const pending = e.page.onDelete();
  e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 1);
  e.page.onHide();
  const count = e.page._setDataCalls.length;
  d.reject(new Error("未知删除结果"));
  await pending;
  assert.equal(e.page._setDataCalls.length, count);
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.deleting, false);
  assert.equal(e.page.data.ready, true);
  assert.equal(e.calls.get.length, 2);
});

for (const p of [DT, ED]) {
  test(`${path.basename(path.dirname(p))}: reload失序旧GET不覆盖新版本`, async () => {
    const old = deferred(), latest = deferred();
    let reads = 0;
    const e = env({ request: () => ++reads === 1 ? Promise.resolve(record()) : reads === 2 ? old.p : latest.p }, { id: "5" }, p);
    await boot(e);
    const first = e.page.loadItem();
    const second = e.page.loadItem();
    assert.equal(e.calls.get.length, 3);
    latest.resolve(record(9, { name: "新响应" }));
    await second;
    old.resolve(record(8, { name: "旧响应" }));
    await first;
    assert.equal(e.page._loaded.version, 9);
    assert.equal(p === DT ? e.page.data.item.name : e.page.data.name, "新响应");
  });
}

test("detail: 旧图error不会污染新图，timer0 hide移除", async () => {
  const e = env();
  await readyDetail(e);
  e.page.onImageError({ currentTarget: { dataset: { imageUrl: "旧图" } } });
  assert.equal(e.page.data.imageFailed, false);
  e.page.onImageError({ currentTarget: { dataset: { imageUrl: "u" } } });
  assert.equal(e.page.data.imageFailed, true);
  const d = deferred();
  const e2 = env({ del: () => d.p }, { id: "5" }, DT);
  await readyDetail(e2);
  const p = e2.page.onDelete();
  e2.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e2.calls.del.length, 1);
  e2.page.onHide();
  d.resolve({});
  await p;
  assert.deepEqual(e2.calls.backs, []);
});

test("templates: auth/form/needsRefresh具有真实边界和组件注册", () => {
  const detail = fs.readFileSync(path.join(MP_DIR, "pages/item-detail/index.wxml"), "utf8");
  const edit = fs.readFileSync(path.join(MP_DIR, "pages/item-edit/index.wxml"), "utf8");
  assert.match(detail, /ready && !busy && item/);
  assert.match(detail, /data-image-url=/);
  assert.match(edit, /ready && loaded && !busy/);
  assert.match(edit, /needsRefresh && !busy/);
  assert.match(edit, /bind:tap="goItems"/);
  assert.match(edit, /disabled="{{!ready \|\| busy \|\| saving \|\| saved \|\| needsRefresh}}"/);
  const json = JSON.parse(fs.readFileSync(path.join(MP_DIR, "pages/item-detail/index.json"), "utf8"));
  assert.equal(json.usingComponents["brutal-button"], "../../components/brutal-button/index");
});
