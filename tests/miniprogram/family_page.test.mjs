import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, makePage, MP_DIR, noticeMock } from "./helpers/loader.mjs";
const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;
const PAGE = path.join(MP_DIR, "pages/family/index.js");
function deferred() { let r, rej; const p = new Promise((res, j) => { r = res; rej = j; }); return { p, resolve: r, reject: rej }; }
async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function env(overrides = {}) {
  const calls = { get: [], post: [], del: [], login: 0, me: 0, toasts: [], navs: [], backs: [], modals: [], shareMenu: 0, switchTab: [], aborts: [] };
  const now = { value: 1700000000000 };
  class FakeDate extends Date { static now() { return now.value; } }
  const storage = new Map();
  const wxBase = mockWx({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: (k) => storage.delete(k),
    showToast: (o) => calls.toasts.push(o.title),
    navigateTo: (o) => calls.navs.push(o.url),
    navigateBack: () => { calls.backs.push(1); },
    switchTab: (o) => calls.switchTab.push(o.url),
    reLaunch: () => {},
    showModal: (o) => { calls.modals.push(o); if (overrides.modal) overrides.modal(o); },
    showShareMenu: () => { calls.shareMenu++; },
    hideShareMenu: () => {},
  });
  const storeMod = loadModule(K("store/index.js"), { globals: { wx: wxBase } });
  const store = storeMod.store;
  if (!overrides.cold) {
    store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: overrides.member ? 9 : 1, role: overrides.member ? "member" : "owner" }]);
  }
  const apiMod = {
    ApiError: class extends Error { constructor(b, sc = 0) { super(b.message); this.code = b.code; this.retryable = b.retryable; this.statusCode = sc; } },
    request: (o) => {
      if (o.onTask) o.onTask({ abort: () => calls.aborts.push(o.path) });
      if (o.method === "DELETE") { calls.del.push(o.path); return overrides.del ? overrides.del(o) : Promise.resolve({}); }
      if (o.method === "POST") { calls.post.push({ path: o.path, body: JSON.parse(JSON.stringify(o.data || {})) }); return overrides.post ? overrides.post(o) : Promise.resolve({ invite_token: "t1", share_path: "pages/family-join/index?invite_token=t1", expires_at: new Date(now.value + 60000).toISOString() }); }
      calls.get.push(o.path);
      return overrides.request ? overrides.request(o) : Promise.resolve({ members: [{ user_id: 1, nickname: "me", avatar_url: "", role: overrides.member ? "member" : "owner", joined_at: "x" }, { user_id: overrides.member ? 9 : 2, nickname: "m2", avatar_url: "", role: overrides.member ? "owner" : "member", joined_at: "x" }] });
    },
  };
  const scopeMod = loadModule(K("services/page-scope.js"), { globals: {}, mocks: { [K("store/index")]: storeMod, [K("services/api")]: apiMod } });
  const authMod = {
    ensureLogin: () => { calls.login++; return overrides.ensureLogin ? overrides.ensureLogin(store) : Promise.resolve(); },
    refreshMe: () => { calls.me++; return overrides.refreshMe ? overrides.refreshMe(store) : Promise.resolve({ user: store.user, families: store.families }); },
  };
  let def;
  loadModule(PAGE, {
    globals: { wx: wxBase, Page: (d) => { def = d; }, getCurrentPages: () => [{}, {}], Date: FakeDate },
    mocks: {
      [K("services/api")]: apiMod, [K("services/auth")]: authMod,
      [K("services/page-scope")]: scopeMod, [K("store/index")]: storeMod,
      [K("services/notice")]: noticeMock(wxBase),
    },
  });
  const page = makePage(def);
  page.onLoad();
  return { page, calls, store, apiMod, now };
}
async function boot(e) { e.page.onShow(); await flush(); }

test("1 cold applyMe→membersGET1 owner", async () => {
  const e = env({ cold: true, ensureLogin: (s) => { s.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]); return Promise.resolve(); } });
  e.page.onShow();
  await flush();
  assert.equal(e.calls.get.length, 1);
  assert.match(e.calls.get[0], /families\/10\/members/);
  assert.equal(e.page.data.isOwner, true);
});
test("2 auth失败清PII+retry", async () => {
  let fails = 1;
  const e = env({ ensureLogin: () => (fails-- > 0 ? Promise.reject(new Error("x")) : Promise.resolve()) });
  e.page.setData({ familyName: "old", members: [{ user_id: 9 }] });
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.familyName, "");
  assert.equal(e.page.data.errorText, "登录失败，请重试");
  e.page.onRetryTap();
  await flush();
  assert.equal(e.calls.login, 2);
});
test("3 nofam 0GET CTA", async () => {
  const e = env({ cold: true, ensureLogin: (s) => { s.applyMe({ id: 1 }, []); return Promise.resolve(); } });
  e.page.onShow();
  await flush();
  assert.equal(e.calls.get.length, 0);
  assert.equal(e.page.data.noFamily, true);
});
test("4 pending membersGET换family不写", async () => {
  const d = deferred();
  const e = env({ request: () => d.p });
  e.page.onShow();
  await flush(3);
  assert.equal(e.calls.get.length, 1);
  e.store.applyMe({ id: 1 }, [{ id: 99, name: "g", owner_user_id: 1, role: "member" }]);
  d.resolve({ members: [{ user_id: 1, nickname: "x", role: "owner" }] });
  await flush();
  assert.equal(e.page.data.members.length, 0);
});
test("5 rename modal开后换UID 0POST", async () => {
  const e = env();
  await boot(e);
  e.page.onRename();
  assert.equal(e.calls.modals.length, 1);
  e.store.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]);
  await e.calls.modals[0].success({ confirm: true, content: "新家" });
  await flush();
  assert.equal(e.calls.post.length, 0);
});
test("5b 双confirm单POST trim原FID", async () => {
  const e = env();
  await boot(e);
  e.page.onRename();
  await e.calls.modals[0].success({ confirm: true, content: "  新家  " });
  await e.calls.modals[0].success({ confirm: true, content: "  新家2  " });
  await flush();
  assert.equal(e.calls.post.length, 1);
  assert.equal(e.calls.post[0].body.name, "新家");
});
test("6 remove伪目标0DELETE真目标1", async () => {
  const e = env();
  await boot(e);
  e.page.onRemoveMember({ currentTarget: { dataset: { id: 999 } } });
  assert.equal(e.calls.del.length, 0);
  e.page.onRemoveMember({ currentTarget: { dataset: { id: 2 } } });
  assert.equal(e.calls.modals.length, 1);
  await e.calls.modals[0].success({ confirm: true });
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 1);
  assert.match(e.calls.del[0], /families\/10\/members\/2/);
});
test("7 invite share cap+hidden generic", async () => {
  const e = env();
  await boot(e);
  await e.page.onInvite();
  await flush();
  assert.equal(e.calls.post.length, 1);
  const share = e.page.onShareAppMessage();
  assert.match(share.path, /family-join\/index\?invite_token=t1/);
  e.page.onHide();
  const s2 = e.page.onShareAppMessage();
  assert.equal(s2.path, "/pages/launch/index");
});
test("8 leave真DELETE_self→navback", async () => {
  const e = env({ member: true, refreshMe: (s) => { s.applyMe({ id: 1 }, []); return Promise.resolve({}); } });
  await boot(e);
  assert.equal(e.page.data.isOwner, false);
  e.page.onLeave();
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.del.length, 1);
  assert.match(e.calls.del[0], /families\/10\/members\/1/);
  assert.equal(e.calls.backs.length, 1);
});
test("a Me deferred→hide→resolve 0写", async () => {
  const d = deferred();
  const e = env({ refreshMe: () => d.p });
  await boot(e);
  e.page.onRename();
  e.calls.modals[0].success({ confirm: true, content: "新" });
  await flush(3);
  e.page.onHide();
  const sd = (e.page._setDataCalls || []).length;
  d.resolve({});
  await flush();
  assert.equal((e.page._setDataCalls || []).length, sd);
});
test("b Me换UID清PII/share不卡busy", async () => {
  const e = env({ refreshMe: (s) => { s.applyMe({ id: 2 }, [{ id: 30, name: "h", owner_user_id: 2, role: "owner" }]); return Promise.resolve({}); } });
  await boot(e);
  e.page.onRename();
  await e.calls.modals[0].success({ confirm: true, content: "新" });
  await flush();
  assert.equal(e.page.data.familyName, "");
  assert.equal(e.page.data.members.length, 0);
  assert.equal(e.page.data.busy, false);
});
test("c rename Me中family变B不清算A成功", async () => {
  const e = env({ refreshMe: (s) => { s.applyMe({ id: 1 }, [{ id: 20, name: "B", owner_user_id: 1, role: "member" }]); return Promise.resolve({}); } });
  await boot(e);
  e.page.onRename();
  await e.calls.modals[0].success({ confirm: true, content: "新" });
  await flush();
  assert.equal(e.calls.toasts.filter((t) => t === "已修改").length, 0);
});
test("d invite pending换家0旧cap+suffix拒绝", async () => {
  const d = deferred();
  const e = env({ post: () => d.p });
  await boot(e);
  e.page.onInvite();
  await flush(2);
  assert.equal(e.calls.post.length, 1);
  e.store.applyMe({ id: 1 }, [{ id: 99, name: "g", owner_user_id: 1, role: "member" }]);
  d.resolve({ invite_token: "t1", share_path: "pages/family-join/index?invite_token=t1&x=evil", expires_at: new Date(Date.now() + 60000).toISOString() });
  await flush();
  assert.equal(e.page._share, null);
  const share = e.page.onShareAppMessage();
  assert.equal(share.path, "/pages/launch/index");
});
test("e owner42无数字1硬编码真实remove", async () => {
  const e = env({
    cold: true,
    ensureLogin: (s) => { s.applyMe({ id: 42 }, [{ id: 10, name: "f", owner_user_id: 42, role: "owner" }]); return Promise.resolve(); },
    request: () => Promise.resolve({ members: [{ user_id: 42, nickname: "o", avatar_url: "", role: "owner", joined_at: "x" }, { user_id: 1, nickname: "m", avatar_url: "", role: "member", joined_at: "x" }] }),
  });
  e.page.onShow();
  await flush();
  assert.equal(e.page.data.isOwner, true);
  assert.equal(e.page.data.currentUserId, 42);
  e.page.onRemoveMember({ currentTarget: { dataset: { id: 1 } } });
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.match(e.calls.del[0], /families\/10\/members\/1/);
});
test("f rename成功Me+members二GET+toast", async () => {
  const e = env();
  await boot(e);
  e.page.onRename();
  await e.calls.modals[0].success({ confirm: true, content: "新家" });
  await flush();
  assert.equal(e.calls.me, 1);
  assert.equal(e.calls.get.length, 2);
  assert.equal(e.calls.toasts.filter((t) => t === "已修改").length, 1);
});
test("i 真FakeDate在expiry前1ms可share、到期generic，不发新请求", async () => {
  const e = env();
  await boot(e);
  await e.page.onInvite();
  assert.equal(e.calls.post.length, 1);
  e.now.value += 59999;
  const r1 = e.page.onShareAppMessage();
  assert.match(r1.path, /family-join/);
  e.now.value++;
  assert.equal(e.page.onShareAppMessage().path, "/pages/launch/index");
  assert.equal(e.calls.post.length, 1);
});
test("i2 suffix sharePath拒绝", async () => {
  const e = env({ post: () => Promise.resolve({ invite_token: "t1", share_path: "pages/family-join/index?invite_token=t1&evil=1", expires_at: new Date(Date.now() + 60000).toISOString() }) });
  await boot(e);
  await e.page.onInvite();
  await flush();
  assert.equal(e.page._share, null);
});
test("iv leave Me保留旧FID→未确认nav0", async () => {
  const e = env({ member: true, refreshMe: (s) => { s.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 9, role: "member" }]); return Promise.resolve({}); } });
  await boot(e);
  assert.equal(e.page.data.isOwner, false);
  e.page.onLeave();
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.backs.length, 0);
  assert.equal(e.page.data.errorText, "退出未确认，请刷新查看");
});
test("iv2 leave成功Me删A保留B→navback+noFamilyfalse", async () => {
  const e = env({ member: true, refreshMe: (s) => { s.applyMe({ id: 1 }, [{ id: 20, name: "B", owner_user_id: 9, role: "member" }], 20); return Promise.resolve({}); } });
  await boot(e);
  assert.equal(e.page.data.isOwner, false);
  e.page.onLeave();
  await e.calls.modals[0].success({ confirm: true });
  await flush();
  assert.equal(e.calls.backs.length, 1);
  assert.equal(e.page.data.noFamily, false);
  assert.equal(e.store.currentFamilyId, 20);
});
test("vi 非数组members不崩+可retry", async () => {
  const e = env({ request: () => Promise.resolve({ members: null }) });
  await boot(e);
  assert.equal(e.page.data.errorText, "成员信息已变化，请重试");
  e.page.onRetryTap();
  await flush();
});

function beginMutation(e, action) {
  let p;
  if (action === "rename") p = e.page.onRename();
  else if (action === "remove") p = e.page.onRemoveMember({ currentTarget: { dataset: { id: 2 } } });
  else p = e.page.onLeave();
  assert.equal(e.calls.modals.length, 1);
  e.calls.modals[0].success({ confirm: true, content: "新家" });
  return p;
}
for (const action of ["rename", "remove", "leave"]) {
  for (const boundary of ["hide", "uid"]) {
    test(`${action}: 真Me pending ${boundary}不写旧页或清新busy`, async () => {
      const d = deferred();
      const e = env({ member: action === "leave", refreshMe: () => d.p });
      await boot(e);
      const pending = beginMutation(e, action);
      await flush(3);
      assert.equal(e.calls.me, 1);
      assert.equal(e.calls.post.length + e.calls.del.length, 1);
      if (boundary === "hide") e.page.onHide();
      else e.store.applyMe({ id: 2 }, [{ id: 30, name: "另一个账号", owner_user_id: 2, role: "owner" }]);
      const count = e.page._setDataCalls.length;
      d.resolve({});
      await pending;
      if (boundary === "hide") assert.equal(e.page._setDataCalls.length, count);
      else {
        assert.equal(e.page.data.familyName, "");
        assert.equal(e.page.data.members.length, 0);
        assert.equal(e.page.data.isOwner, false);
        assert.equal(e.page.data.busy, false);
      }
      assert.equal(e.calls.toasts.length, 0);
      assert.equal(e.calls.backs.length, 0);
      assert.equal(e.calls.switchTab.length, 0);
    });
  }
}
for (const uid of [1, 2]) {
  test(`members GET已发 uid=${uid}变化reject清PII`, async () => {
    const d = deferred();
    const e = env({ request: () => d.p });
    await boot(e);
    assert.equal(e.calls.get.length, 1);
    e.store.applyMe({ id: uid }, [{ id: 20, name: "B", owner_user_id: uid, role: "owner" }]);
    d.reject(new Error("旧错误"));
    await flush();
    assert.equal(e.page.data.familyName, "");
    assert.equal(e.page.data.members.length, 0);
    assert.equal(e.page.data.ready, false);
    assert.equal(e.page.data.busy, false);
    assert.equal(e.page._share, null);
    assert.equal(e.calls.toasts.length, 0);
  });
}
test("members GET native abort与hidden reject零UI写", async () => {
  const d = deferred();
  const e = env({ request: () => d.p });
  await boot(e);
  assert.equal(e.calls.get.length, 1);
  e.page.onHide();
  assert.equal(e.calls.aborts.length, 1);
  const count = e.page._setDataCalls.length;
  d.reject(new Error("NativeAbort"));
  await flush();
  assert.equal(e.page._setDataCalls.length, count);
  assert.equal(e.calls.toasts.length, 0);
});
test("remove成功busy保持到第二GET，真实剩余本人和toast", async () => {
  const d = deferred();
  let reads = 0;
  const owner = { user_id: 1, nickname: "me", role: "owner", avatar_url: "", joined_at: "x" };
  const e = env({
    request: () => ++reads === 1 ? Promise.resolve({ members: [owner, { user_id: 2, nickname: "m", role: "member" }] }) : d.p,
    refreshMe: (s) => {
      s.applyMe({ id: 1 }, [{ id: 10, name: "服务端新名称", owner_user_id: 1, role: "owner" }]);
      return Promise.resolve({});
    },
  });
  await boot(e);
  const pending = beginMutation(e, "remove");
  await flush(3);
  assert.equal(e.calls.me, 1);
  assert.equal(e.calls.get.length, 2);
  assert.equal(e.page.data.busy, true);
  assert.equal(e.page.data.ready, false);
  assert.equal(e.calls.toasts.length, 0);
  d.resolve({ members: [owner] });
  await pending;
  assert.equal(e.page.data.familyName, "服务端新名称");
  assert.equal(e.page.data.members.length, 1);
  assert.equal(e.page.data.members[0].user_id, 1);
  assert.equal(e.page.data.busy, false);
  assert.deepEqual(e.calls.toasts, ["已移除"]);
});
test("未知DELETE结果错误面板必须刷新，旧队列按钮不再写", async () => {
  const e = env({ del: () => Promise.reject(new Error("响应丢失")) });
  await boot(e);
  await beginMutation(e, "remove");
  assert.notEqual(e.page.data.errorText, "");
  e.page.onRename();
  e.page.onRemoveMember({ currentTarget: { dataset: { id: 2 } } });
  await e.page.onInvite();
  assert.equal(e.calls.modals.length, 1);
  assert.equal(e.calls.del.length, 1);
  assert.equal(e.calls.post.length, 0);
  e.page.onRetryTap();
  await flush();
  assert.equal(e.calls.get.length, 2);
  assert.equal(e.page.data.errorText, "");
});
test("members缺自己不得显示其他成员，真retry恢复权限", async () => {
  let reads = 0;
  const e = env({ request: () => Promise.resolve({ members: ++reads === 1
    ? [{ user_id: 2, nickname: "不能展示", role: "member" }]
    : [{ user_id: 1, nickname: "me", role: "owner" }] }) });
  await boot(e);
  assert.equal(e.page.data.ready, false);
  assert.equal(e.page.data.isOwner, false);
  assert.equal(e.page.data.members.length, 0);
  assert.equal(e.page.data.currentUserId, 0);
  e.page.onRetryTap();
  await flush();
  assert.equal(e.page.data.ready, true);
  assert.equal(e.page.data.isOwner, true);
  assert.equal(e.calls.get.length, 2);
});
