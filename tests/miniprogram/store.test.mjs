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
