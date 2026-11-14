import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTsModule, mockWx, MP_DIR } from "./helpers/loader.mjs";

const K = (s) => MP_DIR.replaceAll(path.sep, "/") + "/" + s;

function env() {
  const storage = new Map();
  const wx = mockWx({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
  });
  const storeMod = loadTsModule(K("store/index.ts"), { globals: { wx } });
  const apiMod = loadTsModule(K("services/api.ts"), { globals: { wx } });
  const scopeMod = loadTsModule(K("services/page-scope.ts"), {
    globals: {},
    mocks: {
      [K("store/index")]: storeMod,
      [K("services/api")]: apiMod,
    },
  });
  return { store: storeMod.store, PageScope: scopeMod.PageScope, ApiError: apiMod.ApiError };
}

test("PageScope: show/hide/invalidate代数和task abort", async () => {
  const { store, PageScope } = env();
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const g = new PageScope();
  const f1 = g.show();
  assert.ok(g.isFrameCurrent(f1));
  const aborted = [];
  const op = g.capture();
  const gate = new Promise((res) => setTimeout(res, 5));
  const p = g.run(op, (hooks) => {
    hooks.onTask({ abort: () => aborted.push(1) });
    return gate;
  });
  const f2 = g.invalidate();
  assert.equal(aborted.length, 1);
  assert.ok(!g.isCurrent(op));
  await p;
  g.hide();
  assert.ok(!g.isFrameCurrent(f2));
});

test("PageScope: scopeChanged frame同但store scope变", () => {
  const { store, PageScope } = env();
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const g = new PageScope();
  g.show();
  const op = g.capture();
  assert.ok(g.isCurrent(op));
  store.setFamilies([{ id: 20, name: "f2", owner_user_id: 1, role: "member" }]);
  store.setCurrentFamily(20);
  assert.ok(g.scopeChanged(op));
  assert.ok(!g.isCurrent(op));
});

test("PageScope: run过期抛ApiError CANCELLED", async () => {
  const { PageScope } = env();
  const g = new PageScope();
  const op = g.capture();
  await assert.rejects(g.run(op, () => Promise.resolve(1)), (e) => e.code === "CANCELLED");
});

test("PageScope: onTask替换不abort旧句柄，invalidate只abort当前", async () => {
  const { store, PageScope } = env();
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const g = new PageScope();
  g.show();
  const op = g.capture();
  const aborted = { A: 0, B: 0 };
  const gate = new Promise((res) => setTimeout(res, 10));
  const run = g.run(op, (hooks) => {
    hooks.onTask({ abort: () => aborted.A++ });
    hooks.onTask({ abort: () => aborted.B++ });
    return gate;
  });
  g.invalidate();
  assert.equal(aborted.A, 0);
  assert.equal(aborted.B, 1);
  await run;
  const op2 = g.capture();
  let newAborted = 0;
  const run2 = g.run(op2, (hooks) => {
    hooks.onTask({ abort: () => newAborted++ });
    return Promise.resolve("done");
  });
  assert.equal(await run2, "done");
  assert.equal(newAborted, 0);
});

test("PageScope: 两实例任务互不共享", async () => {
  const { store, PageScope } = env();
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const g1 = new PageScope();
  const g2 = new PageScope();
  g1.show(); g2.show();
  const op = g2.capture();
  let g2Aborted = 0;
  const gate = new Promise((res) => setTimeout(res, 10));
  const run = g2.run(op, (hooks) => {
    hooks.onTask({ abort: () => g2Aborted++ });
    return gate;
  });
  g1.invalidate();
  assert.equal(g2Aborted, 0);
  await run;
});

test("PageScope: abort异常不覆盖run结果", async () => {
  const { store, PageScope } = env();
  store.applyMe({ id: 1 }, [{ id: 10, name: "f", owner_user_id: 1, role: "owner" }]);
  const g = new PageScope();
  g.show();
  const op = g.capture();
  const p = g.run(op, (hooks) => {
    hooks.onTask({ abort: () => { throw new Error("abort fail"); } });
    return Promise.resolve("ok");
  });
  g.invalidate();
  assert.equal(await p, "ok");
});
