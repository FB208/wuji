import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModule, mockWx, MP_DIR } from "./helpers/loader.mjs";

const STORE_PATH = path.join(MP_DIR, "store/index.js");

function loadStore() {
  return loadModule(STORE_PATH, { globals: { wx: mockWx() } }).store;
}

test("store: setCurrentFamily 写入 id，currentFamily 只认列表内家庭", () => {
  const store = loadStore();
  store.families = [{ id: 1, name: "家一", owner_user_id: 9, role: "owner" }];
  store.setCurrentFamily(1);
  assert.equal(store.currentFamilyId, 1);
  assert.equal(store.currentFamily()?.name, "家一");

  store.setCurrentFamily(2);
  assert.equal(store.currentFamilyId, 1);
});

test("store: setFamilies 在缓存 id 失效时回落到首个家庭", () => {
  const store = loadStore();
  store.currentFamilyId = 7;
  store.setFamilies([
    { id: 3, name: "家三", owner_user_id: 1, role: "member" },
    { id: 4, name: "家四", owner_user_id: 1, role: "owner" },
  ]);
  assert.equal(store.currentFamilyId, 3);
});

test("默认家庭只在启动时优先于本地记录，刷新和手动切换不跳回", () => {
  const store = loadStore();
  const families = [{ id: 10 }, { id: 20 }];
  const user = { id: 1, default_family_id: 20 };
  store.pendingFamilyId = 10;
  store.applyMe(user, families);
  assert.equal(store.currentFamilyId, 20);
  store.setCurrentFamily(10);
  const scope = store.captureScope();
  store.applyMe(user, families);
  assert.equal(store.currentFamilyId, 10);
  assert.equal(store.isCurrentScope(scope), true);
  store.clearSession();
  store.applyMe(user, families);
  assert.equal(store.currentFamilyId, 20);
});

test("默认未设置或失效时沿用有效记录，无家庭时归零", () => {
  for (const defaultId of [null, 999]) {
    const store = loadStore();
    store.pendingFamilyId = 20;
    store.applyMe({ id: 1, default_family_id: defaultId }, [{ id: 10 }, { id: 20 }]);
    assert.equal(store.currentFamilyId, 20);
    store.applyMe({ id: 1, default_family_id: null }, [{ id: 10 }]);
    assert.equal(store.currentFamilyId, 10);
    store.applyMe({ id: 1, default_family_id: null }, []);
    assert.equal(store.currentFamilyId, 0);
  }
});

test("主动加入家庭的明确选择优先，切换账号重新应用自己的默认家庭", () => {
  const store = loadStore();
  const families = [{ id: 10 }, { id: 20 }];
  store.applyMe({ id: 1, default_family_id: 10 }, families, 20);
  assert.equal(store.currentFamilyId, 20);
  store.applyMe({ id: 2, default_family_id: 10 }, families);
  assert.equal(store.currentFamilyId, 10);
});
