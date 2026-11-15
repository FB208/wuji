import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, MP_DIR, makePage, noticeMock } from "./helpers/loader.mjs";

const REC = path.join(MP_DIR, "services/recorder.js");
const API = path.join(MP_DIR, "services/api.js");
const STORE = path.join(MP_DIR, "store/index.js");
const COMP = path.join(MP_DIR, "components/hold-to-talk/index.js");

function loadRecorder(globals = {}) {
  const cb = {};
  const manager = {
    startCalls: 0, stopCalls: 0,
    start() { this.startCalls++; },
    stop() { this.stopCalls++; },
    onStart: (f) => { cb.start = f; },
    onStop: (f) => { cb.stop = f; },
    onError: (f) => { cb.error = f; },
    onInterruptionBegin: (f) => { cb.interrupt = f; },
  };
  const mod = loadModule(REC, { globals: { wx: mockWx({ getRecorderManager: () => manager }), ...globals } });
  return { r: mod.recorder, cb, manager };
}

function makeComponent(wxOverrides = {}, recorderStub, globals = {}) {
  const wx = mockWx(wxOverrides);
  let def;
  loadModule(COMP, {
    globals: { wx, Component: (d) => { def = d; }, ...globals },
    mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/recorder"]: { recorder: recorderStub } },
  });
  const inst = {
    data: JSON.parse(JSON.stringify(def.data)),
    properties: {},
    events: [],
    _setDataCalls: [],
    setData(patch) { this._setDataCalls.push(patch); Object.assign(this.data, patch); },
    triggerEvent(name, detail) { this.events.push([name, detail]); },
  };
  for (const [k, v] of Object.entries(def.methods || {})) inst[k] = v.bind(inst);
  for (const [k, v] of Object.entries(def.lifetimes || {})) inst[k] = v.bind(inst);
  for (const [k, v] of Object.entries(def.pageLifetimes || {})) inst[k] = v.bind(inst);
  for (const [k, p] of Object.entries(def.properties || {})) inst.properties[k] = p.value;
  inst.data.disabled = inst.properties.disabled;
  return inst;
}

test("recorder: 时长边界 999拒/1000收/60000收/60001拒", async () => {
  for (const [dur, ok] of [[999, false], [1000, true], [60000, true], [60001, false], [0, false], [NaN, false], [-5, false]]) {
    const { r, cb } = loadRecorder();
    const p = r.start();
    cb.start();
    const done = p.then(() => "resolved", (e) => e.message);
    cb.stop({ tempFilePath: "t", duration: dur });
    const out = await done;
    if (ok) assert.equal(out, "resolved", `${dur} should pass`);
    else assert.match(out, /太短|失败|超时|超过60/, `${dur} should reject`);
  }
});

test("recorder: 缺duration按onStart起算fallback", async () => {
  let now = 0;
  const { r, cb } = loadRecorder({ Date: { now: () => now } });
  const p = r.start();
  cb.start();
  const done = p.then((x) => x, (e) => e);
  now = 1000;
  cb.stop({ tempFilePath: "t" });
  const res = await done;
  assert.equal(res.tempFilePath, "t");
  assert.equal(res.durationMs, 1000);
});

test("recorder: onStop先于手动stop仍结算同一Promise", async () => {
  const { r, cb } = loadRecorder();
  const p = r.start();
  cb.start();
  cb.stop({ tempFilePath: "a", duration: 3000 });
  const first = await p;
  const second = await r.stop();
  assert.equal(first, second);
});

test("recorder: sticky cancel，stop(true)后stop(false)仍null", async () => {
  const { r, cb } = loadRecorder();
  const p = r.start();
  cb.start();
  r.stop(true);
  r.stop(false);
  cb.stop({ tempFilePath: "x", duration: 5000 });
  assert.equal(await p, null);
});

test("recorder: 中断主动stop并结算null", async () => {
  const { r, cb, manager } = loadRecorder();
  const p = r.start();
  cb.start();
  cb.interrupt();
  assert.ok(manager.stopCalls >= 1);
  cb.stop({ tempFilePath: "x", duration: 5000 });
  assert.equal(await p, null);
});

test("recorder: watchdog拒绝后旧ack释放锁，新start不受污染", async () => {
  const { r, cb, manager } = loadRecorder();
  const p1 = r.start();
  cb.start();
  const settled1 = p1.then(() => "ok", (e) => e.message);
  r.stop();
  await new Promise((res) => setTimeout(res, 5200));
  assert.match(await settled1, /超时/);
  await assert.rejects(r.start(), /尚未结束/);
  cb.stop({ tempFilePath: "late", duration: 9000 });
  const p2 = r.start();
  cb.start();
  cb.stop({ tempFilePath: "new", duration: 4000 });
  const r2 = await p2;
  assert.equal(r2.tempFilePath, "new");
});

test("recorder: expectedPromise不匹配不停止别会话", async () => {
  const { r, cb, manager } = loadRecorder();
  const p1 = r.start();
  cb.start();
  const foreign = Promise.resolve(null);
  const ret = await r.stop(true, foreign);
  assert.equal(ret, null);
  assert.equal(manager.stopCalls, 0);
  cb.stop({ tempFilePath: "own", duration: 5000 });
  assert.equal((await p1).tempFilePath, "own");
});

test("component: 授权等待期release后不start", async () => {
  const calls = { start: 0 };
  let grant;
  const recorderStub = {
    requestPermission: () => new Promise((resolve) => { grant = resolve; }),
    start: () => { calls.start++; return new Promise(() => {}); },
    stop: () => Promise.resolve(null),
  };
  const inst = makeComponent({ getSetting: () => new Promise(() => {}) }, recorderStub);
  const promise = inst.onTouchStart({ touches: [{ clientY: 100 }] });
  inst.onTouchEnd();
  grant(true);
  await promise;
  assert.equal(calls.start, 0);
});

test("component: touchend传递willCancel，touchcancel恒cancel", async () => {
  const stops = [];
  const pending = Promise.resolve(null);
  const inst = makeComponent({}, { stop: (cancel, p) => { stops.push([cancel, p]); return Promise.resolve(null); } });
  inst._pending = pending;
  inst._started = true;
  inst.setData({ recording: true, willCancel: true });
  inst.onTouchEnd();
  assert.deepEqual(stops[0], [true, pending]);
  inst.setData({ recording: true, willCancel: false });
  inst.onTouchCancel();
  assert.deepEqual(stops[1], [true, pending]);
  assert.equal(inst.data.recording, false);
  assert.equal(inst.data.willCancel, false);
});

test("api: upload合法错误JSON保留code/retryable/RetryAfter", async () => {
  const wx = mockWx({
    uploadFile: (o) => {
      o.success({ statusCode: 400, data: JSON.stringify({ error: { code: "FAMILY_ITEMS_FULL", message: "满", retryable: false } }), header: { "Retry-After": "3" } });
      return { onProgressUpdate: () => {} };
    },
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  await assert.rejects(api.uploadFile({ path: "/x", filePath: "f", name: "n" }), (e) => {
    assert.equal(e.code, "FAMILY_ITEMS_FULL");
    assert.equal(e.retryable, false);
    assert.equal(e.retryAfterMs, 3000);
    return true;
  });
});

test("api: 成功transcript含AUTH_REQUIRED文本不触发恢复", async () => {
  let recovery = 0;
  const wx = mockWx({
    uploadFile: (o) => {
      o.success({ statusCode: 200, data: JSON.stringify({ data: { transcript: "AUTH_REQUIRED" } }), header: {} });
      return { onProgressUpdate: () => {} };
    },
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => { recovery++; return true; });
  const out = await api.uploadFile({ path: "/x", filePath: "f", name: "n" });
  assert.equal(out.transcript, "AUTH_REQUIRED");
  assert.equal(recovery, 0);
});

test("api: 两个并发401只恢复一次各重放一次，再401不循环", async () => {
  let recovery = 0, hits = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wx = mockWx({
    request: (o) => {
      hits++;
      o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} });
    },
    getStorageSync: () => "tok", setStorageSync: () => {},
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => { recovery++; await gate; return true; });
  const waiting = Promise.allSettled([api.request({ path: "/a" }), api.request({ path: "/b" })]);
  assert.equal(hits, 2);
  release();
  const results = await waiting;
  assert.equal(recovery, 1);
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.code === "AUTH_REQUIRED"));
  assert.equal(hits, 4);
});

test("api: 恢复等待期间cancel生效不重放", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const wx = mockWx({
    request: (o) => {
      o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} });
    },
    getStorageSync: () => "tok", setStorageSync: () => {},
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => { await gate; return true; });
  let cancelled = false;
  const p = api.request({ path: "/a", isCancelled: () => cancelled });
  cancelled = true;
  release();
  await assert.rejects(p, (e) => e.code === "CANCELLED");
});

test("api: 初次send后修改options重放仍原payload", async () => {
  const bodies = [];
  let hits = 0;
  const wx = mockWx({
    request: (o) => {
      hits++; bodies.push(JSON.parse(JSON.stringify(o.data)));
      if (hits === 1) { o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} }); return; }
      o.success({ statusCode: 200, data: { data: 1 }, header: {} });
    },
    getStorageSync: () => "tok", setStorageSync: () => {},
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => true);
  const options = { path: "/x", method: "POST", data: { a: 1, nested: { b: 2 } }, idempotencyKey: "k1" };
  const p = api.request(options);
  options.data.a = 99; options.data.nested.b = 99; options.idempotencyKey = "k2";
  await p;
  assert.equal(bodies[1].a, 1);
  assert.equal(bodies[1].nested.b, 2);
});

test("api: abort/timeout分别报错，502不恢复", async () => {
  let recovery = 0;
  const apiA = loadModule(API, { globals: { wx: mockWx({ request: (o) => o.fail({ errMsg: "request:fail abort" }), getStorageSync: () => "t" }) }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(mockWx()) } });
  apiA.registerAuthRecovery(async () => { recovery++; return true; });
  await assert.rejects(apiA.request({ path: "/x" }), (e) => e.code === "ABORTED");
  const apiT = loadModule(API, { globals: { wx: mockWx({ request: (o) => o.fail({ errMsg: "request:fail timeout" }), getStorageSync: () => "t" }) }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(mockWx()) } });
  apiT.registerAuthRecovery(async () => { recovery++; return true; });
  await assert.rejects(apiT.request({ path: "/x" }), (e) => e.code === "TIMEOUT" && e.retryable === true);
  const api5 = loadModule(API, { globals: { wx: mockWx({ request: (o) => o.success({ statusCode: 502, data: { error: { code: "X", message: "x", retryable: true } }, header: {} }), getStorageSync: () => "t" }) }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(mockWx()) } });
  api5.registerAuthRecovery(async () => { recovery++; return true; });
  await assert.rejects(api5.request({ path: "/x" }), (e) => e.code === "X");
  assert.equal(recovery, 0);
});

test("auth: blocked持久化ensureLogin抛LOGIN_BLOCKED", async () => {
  const mem = {};
  const wx = mockWx({
    getStorageSync: (k) => mem[k],
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
  });
  const auth = loadModule(path.join(MP_DIR, "services/auth.js"), {
    globals: { wx },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: { ApiError: class extends Error { constructor(b){super(b.message);this.code=b.code;this.retryable=b.retryable;} }, getToken: () => "", request: () => Promise.reject(new Error("no net")), setToken: () => {}, registerAuthRecovery: () => {} },
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: { store: { user: null, families: [], currentFamilyId: 0, restore: () => {}, applyMe: () => {}, setCurrentFamily: () => {}, clearSession: () => {}, captureScope: () => ({}), isCurrentScope: () => true } },
    },
  });
  auth.blockAutoLogin();
  await assert.rejects(auth.ensureLogin(), (e) => e.code === "LOGIN_BLOCKED");
});

test("store: restore不提前曝光currentFamilyId，applyMe确认偏好", () => {
  const mem = { wuji_current_family_id: 5 };
  const wx = mockWx({
    getStorageSync: (k) => mem[k],
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
  });
  const store = loadModule(STORE, { globals: { wx } }).store;
  store.currentFamilyId = 0;
  store.restore();
  assert.equal(store.currentFamilyId, 0);
  store.applyMe({ id: 1 }, [{ id: 5, name: "f5", owner_user_id: 1, role: "owner" }, { id: 9, name: "f9", owner_user_id: 1, role: "owner" }]);
  assert.equal(store.currentFamilyId, 5);
  store.setUser({ id: 2 });
  assert.equal(store.families.length, 0);
  assert.equal(store.currentFamilyId, 0);
});

test("recorder: 同步stop throw保留ack锁，ack后可新会话", async () => {
  const { r, cb, manager } = loadRecorder();
  const p1 = r.start();
  cb.start();
  const origStop = manager.stop;
  manager.stop = () => { throw new Error("sync"); };
  const settled = p1.then(() => "ok", (e) => e.message);
  r.stop();
  assert.match(await settled, /失败|throw|stop|sync/);
  await assert.rejects(r.start(), /尚未结束/);
  manager.stop = origStop;
  cb.error();
  const p2 = r.start();
  cb.start();
  cb.stop({ tempFilePath: "n", duration: 3000 });
  assert.equal((await p2).tempFilePath, "n");
});

function makeDeferred() {
  let resolve;
  const p = new Promise((res) => { resolve = res; });
  return { p, resolve };
}

for (const release of ["touchend", "hide", "detach"]) {
  test(`component: 授权deferred期间${release}不start不stop`, async () => {
    const calls = { start: 0, stop: 0 };
    const gate = makeDeferred();
    const inst = makeComponent({}, {
      requestPermission: () => gate.p,
      start: () => { calls.start++; return new Promise(() => {}); },
      stop: () => { calls.stop++; return Promise.resolve(null); },
    });
    inst._visible = true;
    const pending = inst.onTouchStart({ touches: [{ clientY: 10 }] });
    await Promise.resolve();
    if (release === "touchend") inst.onTouchEnd();
    else if (release === "hide") inst.hide();
    else inst.detached();
    gate.resolve(true);
    await pending;
    await Promise.resolve();
    assert.equal(calls.start, 0);
    assert.equal(calls.stop, 0);
  });
}

test("component: native onStart前松手取消自己pending", async () => {
  const stops = [];
  let onStartCb;
  const inst = makeComponent({}, {
    requestPermission: () => Promise.resolve(true),
    start: (cb) => { onStartCb = cb; return new Promise(() => {}); },
    stop: (cancel, expected) => { stops.push([cancel, expected]); return Promise.resolve(null); },
  });
  inst._visible = true;
  await inst.onTouchStart({ touches: [{ clientY: 10 }] });
  const pending = inst._pending;
  assert.ok(pending);
  assert.equal(inst.data.recording, true);
  inst.onTouchEnd();
  assert.equal(stops.length, 0);
  onStartCb();
  assert.equal(stops.length, 1);
  assert.equal(stops[0][0], true);
  assert.equal(stops[0][1], pending);
});

test("component: autoStop一次finish+recording=false+可再录", async () => {
  const sessions = [];
  const cleared = [];
  let nextTimer = 0;
  const inst = makeComponent({}, {
    requestPermission: () => Promise.resolve(true),
    start: (onStart) => {
      const session = makeDeferred();
      sessions.push({ ...session, onStart });
      return session.p;
    },
    stop: () => Promise.resolve(null),
  }, {
    setInterval: () => nextTimer++,
    clearInterval: (id) => cleared.push(id),
  });
  inst.attached();
  await inst.onTouchStart({ touches: [{ clientY: 10 }] });
  assert.equal(sessions.length, 1);
  sessions[0].onStart();
  assert.equal(inst.data.recording, true);
  sessions[0].resolve({ tempFilePath: "a.mp3" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const finishes = inst.events.filter(([n]) => n === "recordfinish");
  assert.equal(finishes.length, 1);
  assert.equal(inst.data.recording, false);
  assert.ok(cleared.includes(0));
  await inst.onTouchStart({ touches: [{ clientY: 10 }] });
  assert.equal(sessions.length, 2);
  sessions[1].onStart();
  inst.onTouchCancel();
  sessions[1].resolve(null);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(inst.events.filter(([n]) => n === "recordfinish").length, 1);
  assert.equal(inst.data.recording, false);
});

test("component: hide后旧promise resolve不setData", async () => {
  let resolveSession;
  const inst = makeComponent({}, {
    requestPermission: () => Promise.resolve(true),
    start: (cb) => new Promise((res) => { resolveSession = res; }),
    stop: () => Promise.resolve(null),
  });
  inst._visible = true;
  await inst.onTouchStart({ touches: [{ clientY: 10 }] });
  inst.hide();
  const callsBefore = inst._setDataCalls.length;
  resolveSession({ tempFilePath: "late.mp3" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const callsAfter = (inst._setDataCalls || []).length;
  assert.equal(callsAfter, callsBefore);
});

test("api: upload两并发401单飞恢复各重放一次且formData冻结", async () => {
  const calls = [];
  let recovery = 0;
  const gate = makeDeferred();
  const wx = mockWx({
    uploadFile: (o) => {
      calls.push(JSON.parse(JSON.stringify(o.formData)));
      if (calls.length <= 2) {
        o.success({ statusCode: 401, data: JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }), header: {} });
      } else {
        o.success({ statusCode: 200, data: JSON.stringify({ data: { ok: 1 } }), header: {} });
      }
      return { onProgressUpdate: (cb) => { o._prog = cb; } };
    },
    getStorageSync: () => "tok",
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => { recovery++; await gate.p; return true; });
  const opts = { path: "/x", filePath: "f", name: "n", formData: { a: 1 } };
  const p1 = api.uploadFile(opts);
  const p2 = api.uploadFile({ path: "/y", filePath: "f", name: "n", formData: { a: 1 } });
  opts.formData.a = 99;
  gate.resolve();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(recovery, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].a, 1);
});

test("api: request重放仍带原Idempotency-Key", async () => {
  const headers = [];
  let hits = 0;
  const wx = mockWx({
    request: (o) => {
      hits++; headers.push(o.header["Idempotency-Key"]);
      if (hits === 1) o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} });
      else o.success({ statusCode: 200, data: { data: 1 }, header: {} });
    },
    getStorageSync: () => "tok",
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => true);
  await api.request({ path: "/x", method: "POST", data: {}, idempotencyKey: "k1" });
  assert.equal(headers[0], "k1");
  assert.equal(headers[1], "k1");
});

test("api: onProgress回调收到percent", async () => {
  const wx = mockWx({
    uploadFile: (o) => {
      const task = { onProgressUpdate: (cb) => cb({ progress: 42 }) };
      queueMicrotask(() => o.success({ statusCode: 200, data: JSON.stringify({ data: 1 }), header: {} }));
      return task;
    },
    getStorageSync: () => "tok",
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  let pct = 0;
  await api.uploadFile({ path: "/x", filePath: "f", name: "n", onProgress: (p) => { pct = p; } });
  assert.equal(pct, 42);
});

test("api: Retry-After HTTP日期解析为ms", async () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const wx = mockWx({
    request: (o) => o.success({ statusCode: 429, data: { error: { code: "RATE_LIMITED", message: "x", retryable: true } }, header: { "Retry-After": future } }),
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  await assert.rejects(api.request({ path: "/x" }), (e) => e.retryAfterMs > 0 && e.retryAfterMs <= 6000);
});

test("api: 502/timeout不清token", async () => {
  const mem = { wuji_access_token: "tok" };
  const wx = mockWx({
    request: (o) => o.success({ statusCode: 502, data: { error: { code: "X", message: "x", retryable: true } }, header: {} }),
    getStorageSync: (k) => mem[k],
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  await assert.rejects(api.request({ path: "/x" }), (e) => e.code === "X");
  assert.equal(mem.wuji_access_token, "tok");
});

function makeAuthEnv() {
  const mem = { wuji_access_token: "" };
  const http = {
    loginCount: 0,
    meCount: 0,
    business401: true,
    loginUser: { id: 1, nickname: null, avatar_url: null },
    meGate: null,
    requests: [],
    loginBodies: [],
  };
  const wx = mockWx({
    getStorageSync: (k) => mem[k],
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
    login: (o) => {
      http.loginCount++;
      o.success({ code: "wxcode" });
    },
    request: (o) => {
      const url = o.url;
      http.requests.push(url);
      const respond = (fn) => {
        if (http.meGate && url.includes("/me")) http.meGate.then(fn);
        else fn();
      };
      respond(() => {
        if (url.includes("/auth/wechat-login")) {
          http.loginBodies.push(o.data);
          o.success({
            statusCode: 200,
            data: { data: { access_token: "logintok", user: http.loginUser, current_family_id: 1 } },
            header: {},
          });
        } else if (url.includes("/me")) {
          http.meCount++;
          if (http.me401 || (http.expiredToken && o.header.Authorization === `Bearer ${http.expiredToken}`)) {
            o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} });
          } else {
            o.success({ statusCode: 200, data: { data: { user: http.loginUser, families: http.families || [] } }, header: {} });
          }
        } else if (http.business401) {
          o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} });
        } else {
          o.success({ statusCode: 200, data: { data: "biz" }, header: {} });
        }
      });
    },
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  const storeMod = loadModule(STORE, { globals: { wx } });
  const auth = loadModule(path.join(MP_DIR, "services/auth.js"), {
    globals: { wx },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: api,
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: storeMod,
    },
  });
  return { api, store: storeMod.store, auth, http, mem, wx };
}

test("auth: warmed401恢复不自锁，login一次", { timeout: 500 }, async () => {
  const env = makeAuthEnv();
  env.mem.wuji_access_token = "old";
  env.store.user = { id: 1 };
  env.http.me401 = true;
  env.auth.installAuthRecovery();
  const t0 = Date.now();
  await assert.rejects(
    env.api.request({ path: "/business" }),
    (e) => e.statusCode === 401 || e.code === "AUTH_REQUIRED"
  );
  assert.ok(Date.now() - t0 < 2000, "recovery deadlock");
  assert.equal(env.http.loginCount, 1);
  assert.equal(env.http.meCount, 1);
  assert.equal(env.http.requests.filter((url) => url.endsWith("/business")).length, 1);
  assert.equal(env.http.loginBodies[0].allow_registration, false);
});

test("auth: blocked ensureLogin抛LOGIN_BLOCKED且零login", async () => {
  const env = makeAuthEnv();
  env.auth.blockAutoLogin();
  await assert.rejects(env.auth.ensureLogin(), (e) => e.code === "LOGIN_BLOCKED");
  assert.equal(env.http.loginCount, 0);
});

test("auth: interactive清guard并完成登录", async () => {
  const env = makeAuthEnv();
  env.auth.blockAutoLogin();
  env.mem.wuji_access_token = "";
  env.store.user = null;
  env.http.me401 = false;
  await env.auth.ensureLogin({ interactive: true });
  assert.equal(env.http.loginCount, 1);
});

test("auth: refreshMe网络失败保留token", async () => {
  const mem = { wuji_access_token: "tok" };
  const wx = mockWx({
    request: (o) => o.fail({ errMsg: "net" }),
    getStorageSync: (k) => mem[k],
    removeStorageSync: (k) => { delete mem[k]; },
  });
  const api = loadModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  const auth = loadModule(path.join(MP_DIR, "services/auth.js"), {
    globals: { wx },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: api,
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: loadModule(STORE, { globals: { wx } }),
    },
  });
  await assert.rejects(auth.refreshMe(), (e) => e.code === "NETWORK_ERROR");
  assert.equal(mem.wuji_access_token, "tok");
});

test("auth: app.onLaunch显式注册恢复handler", () => {
  let installed = null;
  let def;
  const wx = mockWx({});
  loadModule(path.join(MP_DIR, "app.js"), {
    globals: { wx, App: (d) => { def = d; } },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/auth"]: {
        installAuthRecovery: () => { installed = true; },
      },
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: {
        store: { restore: () => {} },
      },
    },
  });
  def.onLaunch();
  assert.equal(installed, true);
});

test("store: setStorageSync抛错applyMe仍原子完成", () => {
  const wx = mockWx({
    getStorageSync: () => "",
    setStorageSync: () => { throw new Error("quota"); },
    removeStorageSync: () => { throw new Error("quota"); },
  });
  const store = loadModule(STORE, { globals: { wx } }).store;
  store.applyMe({ id: 1 }, [{ id: 1, name: "old", owner_user_id: 1, role: "owner" }]);
  store.applyMe({ id: 2 }, [{ id: 2, name: "f", owner_user_id: 2, role: "owner" }]);
  assert.equal(store.user.id, 2);
  assert.equal(store.currentFamilyId, 2);
  assert.deepEqual(store.families.map((f) => f.id), [2]);
  store.clearSession();
  assert.equal(store.user, null);
  assert.equal(store.currentFamilyId, 0);
  assert.deepEqual(store.families, []);
});

async function waitFor(predicate) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("预期的异步步骤未发生");
}

for (const change of ["user", "token"]) {
  test(`auth: 恢复期间变更${change}不重放旧写入`, { timeout: 500 }, async () => {
    const env = makeAuthEnv();
    env.mem.wuji_access_token = "old";
    env.store.applyMe({ id: 1 }, [{ id: 1, name: "a", role: "owner", owner_user_id: 1 }]);
    const gate = makeDeferred();
    env.http.meGate = gate.p;
    env.auth.installAuthRecovery();
    const result = env.api.request({ path: "/business", method: "POST", data: { family_id: 1 } })
      .then((value) => ({ value }), (error) => ({ error }));
    await waitFor(() => env.http.requests.some((url) => url.endsWith("/me")));
    env.mem.wuji_access_token = "another-token";
    if (change === "user") {
      env.store.applyMe({ id: 2 }, [{ id: 2, name: "b", role: "owner", owner_user_id: 2 }]);
    }
    gate.resolve();
    const outcome = await result;
    assert.equal(outcome.error.code, "AUTH_REQUIRED");
    assert.equal(env.http.requests.filter((url) => url.endsWith("/business")).length, 1);
    assert.equal(env.mem.wuji_access_token, "another-token");
    assert.equal(env.store.user.id, change === "user" ? 2 : 1);
    assert.equal(env.store.currentFamilyId, change === "user" ? 2 : 1);
  });
}

test("auth: 冷启动过期token禁止自动注册，新用户首次允许注册", { timeout: 500 }, async () => {
  for (const existing of [true, false]) {
    const env = makeAuthEnv();
    if (existing) {
      env.mem.wuji_access_token = "old";
      env.http.expiredToken = "old";
    }
    await env.auth.ensureLogin();
    assert.equal(env.http.loginBodies.length, 1);
    assert.equal(env.http.loginBodies[0].allow_registration, !existing);
    assert.equal(env.store.user.id, 1);
  }
});

test("auth: guard跨模块重载生效，显式登录才解除", { timeout: 500 }, async () => {
  const env = makeAuthEnv();
  env.auth.blockAutoLogin();
  const auth = loadModule(path.join(MP_DIR, "services/auth.js"), {
    globals: { wx: env.wx },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: env.api,
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: { store: env.store },
    },
  });
  await assert.rejects(auth.ensureLogin(), (e) => e.code === "LOGIN_BLOCKED");
  assert.equal(env.http.loginCount, 0);
  await auth.ensureLogin({ interactive: true });
  assert.equal(env.http.loginBodies[0].allow_registration, true);
  assert.equal(env.mem.wuji_login_blocked, undefined);
});

test("auth: 旧me不能覆盖新用户，同用户保留等待期间的新选择", { timeout: 500 }, async () => {
  for (const changeUser of [true, false]) {
    const env = makeAuthEnv();
    const families = [1, 2].map((id) => ({ id, name: `家${id}`, role: "owner", owner_user_id: 1 }));
    env.mem.wuji_access_token = "old";
    env.store.applyMe({ id: 1 }, families, 1);
    env.http.families = families;
    const gate = makeDeferred();
    env.http.meGate = gate.p;
    const pending = env.auth.refreshMe(true).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, code: e.code })
    );
    if (changeUser) {
      env.mem.wuji_access_token = "user2";
      env.store.applyMe({ id: 2 }, [{ ...families[1], owner_user_id: 2 }], 2);
    } else {
      env.store.setCurrentFamily(2);
    }
    gate.resolve();
    const outcome = await pending;
    if (changeUser) {
      assert.equal(outcome.code, "CANCELLED");
      assert.equal(env.store.user.id, 2);
      assert.equal(env.store.currentFamilyId, 2);
      assert.deepEqual(env.store.families.map((f) => f.id), [2]);
    } else {
      assert.equal(outcome.ok, true);
      assert.equal(env.store.user.id, 1);
      assert.equal(env.store.currentFamilyId, 2);
      assert.deepEqual(env.store.families.map((f) => f.id), [1, 2]);
    }
  }
});

test("auth: launch重试是明确交互登录", async () => {
  let config;
  const calls = [];
  const wx = mockWx();
  const storeMod = loadModule(path.join(MP_DIR, "store/index.js"), { globals: { wx } });
  const apiMod = loadModule(path.join(MP_DIR, "services/api.js"), { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  const scopeMod = loadModule(path.join(MP_DIR, "services/page-scope.js"), {
    globals: {},
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: storeMod,
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: apiMod,
    },
  });
  loadModule(path.join(MP_DIR, "pages/launch/index.js"), {
    globals: { wx, Page: (definition) => { config = definition; } },
    mocks: {
      [MP_DIR.replaceAll(path.sep, "/") + "/services/auth"]: {
        ensureLogin: async (options) => {
          calls.push(options);
          if (calls.length === 1) throw new apiMod.ApiError({ code: "NETWORK_ERROR", message: "x", retryable: true });
        },
      },
      [MP_DIR.replaceAll(path.sep, "/") + "/services/api"]: apiMod,
      [MP_DIR.replaceAll(path.sep, "/") + "/services/page-scope"]: scopeMod,
      [MP_DIR.replaceAll(path.sep, "/") + "/store/index"]: storeMod,
    },
  });
  const page = makePage(config);
  page.onLoad();
  page.onShow();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  page.onRetry();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].interactive, true);
});

test("store: 损坏的本地家庭偏好不会变成当前家庭", () => {
  for (const saved of ["5", {}, -1, Infinity, NaN, 0]) {
    const store = loadModule(STORE, { globals: { wx: mockWx({ getStorageSync: () => saved }) } }).store;
    store.restore();
    assert.equal(store.currentFamilyId, 0);
    store.applyMe({ id: 1 }, [{ id: 5, name: "合法家庭", owner_user_id: 1, role: "owner" }]);
    assert.equal(store.currentFamilyId, 5);
  }
});
