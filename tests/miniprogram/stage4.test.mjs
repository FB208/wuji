import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTsModule, mockWx, MP_DIR, noticeMock } from "./helpers/loader.mjs";

const REC = path.join(MP_DIR, "services/recorder.ts");
const API = path.join(MP_DIR, "services/api.ts");
const STORE = path.join(MP_DIR, "store/index.ts");

function loadRecorder() {
  const callbacks = {};
  const manager = {
    startCalls: 0, stopCalls: 0,
    start() { this.startCalls++; },
    stop() { this.stopCalls++; },
    onStart: (cb) => { callbacks.start = cb; },
    onStop: (cb) => { callbacks.stop = cb; },
    onError: (cb) => { callbacks.error = cb; },
    onInterruptionBegin: (cb) => { callbacks.interrupt = cb; },
  };
  const mod = loadTsModule(REC, { globals: { wx: mockWx({ getRecorderManager: () => manager }) } });
  return { recorder: mod.recorder, callbacks, manager };
}

test("recorder: 自动onStop在手动stop前结算同一Promise", async () => {
  const { recorder, callbacks } = loadRecorder();
  const p = recorder.start();
  callbacks.start();
  callbacks.stop({ tempFilePath: "a.mp3", duration: 3000 });
  const r1 = await p;
  assert.equal(r1.tempFilePath, "a.mp3");
  const r2 = await recorder.stop();
  assert.equal(r2, r1);
});

test("recorder: 短于1秒拒绝，SDK duration优先", async () => {
  const { recorder, callbacks } = loadRecorder();
  const p = recorder.start();
  callbacks.start();
  callbacks.stop({ tempFilePath: "x", duration: 500 });
  await assert.rejects(p, /太短/);
});

test("recorder: 未录音stop返回null，onError结算", async () => {
  const { recorder, callbacks } = loadRecorder();
  assert.equal(await recorder.stop(), null);
  const p = recorder.start();
  callbacks.error();
  await assert.rejects(p, /失败/);
});

test("recorder: 重复stop返回同一Promise，中断按cancel", async () => {
  const { recorder, callbacks } = loadRecorder();
  const p1 = recorder.start();
  callbacks.start();
  const p2 = recorder.stop(true);
  assert.equal(p1, p2);
  callbacks.interrupt();
  callbacks.stop({ tempFilePath: "z", duration: 9000 });
  assert.equal(await p1, null);
});

test("api: 坏JSON统一ApiError", async () => {
  const wx = mockWx({
    request: (o) => o.success({ statusCode: 200, data: "not json", header: {} }),
  });
  const api = loadTsModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  await assert.rejects(api.request({ path: "/x" }), (e) => e.code === "INVALID_RESPONSE");
});

test("api: 401单飞恢复一次", async () => {
  let loginCalls = 0;
  const wx = mockWx({
    request: (o) => {
      if (loginCalls === 0) { o.success({ statusCode: 401, data: { error: { code: "AUTH_REQUIRED", message: "x", retryable: false } }, header: {} }); return; }
      o.success({ statusCode: 200, data: { data: 1 }, header: {} });
    },
  });
  const api = loadTsModule(API, { globals: { wx }, mocks: { [MP_DIR.replaceAll(path.sep, "/") + "/services/notice"]: noticeMock(wx) } });
  api.registerAuthRecovery(async () => { loginCalls++; return true; });
  const [a, b] = await Promise.all([api.request({ path: "/a" }), api.request({ path: "/b" })]);
  assert.equal(loginCalls, 1);
});

test("store: applyMe原子+scopeVersion+无效id回落", () => {
  const store = loadTsModule(STORE, { globals: { wx: mockWx() } }).store;
  const v0 = store.scopeVersion;
  store.applyMe({ id: 7 }, [{ id: 1, name: "a", owner_user_id: 7, role: "owner" }]);
  assert.ok(store.scopeVersion > v0);
  const scope = store.captureScope();
  assert.ok(store.isCurrentScope(scope));
  store.setCurrentFamily(99);
  assert.equal(store.currentFamilyId, 1);
  store.clearSession();
  assert.equal(store.currentFamilyId, 0);
  assert.ok(!store.isCurrentScope(scope));
});
