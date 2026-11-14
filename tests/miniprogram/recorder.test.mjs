import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTsModule, mockWx, MP_DIR } from "./helpers/loader.mjs";

const RECORDER_PATH = path.join(MP_DIR, "services/recorder.ts");

function loadRecorder() {
  const callbacks = {};
  const clock = { t: 0 };
  const manager = {
    onStop: (cb) => { callbacks.stop = cb; },
    onError: (cb) => { callbacks.error = cb; },
    onStart: (cb) => { callbacks.start = cb; },
    onInterruptionBegin: (cb) => { callbacks.interrupt = cb; },
    start: () => {},
    stop: () => {},
  };
  const wx = mockWx({ getRecorderManager: () => manager });
  const fakeDate = { now: () => clock.t };
  const mod = loadTsModule(RECORDER_PATH, {
    globals: { wx, Date: fakeDate },
  });
  return { recorder: mod.recorder, callbacks, manager, clock };
}

test("recorder: 手动 stop 后 onStop 事件正常结算", async () => {
  const { recorder, callbacks, clock } = loadRecorder();
  clock.t = 100;
  recorder.start();
  const p = recorder.stop();
  clock.t = 2100;
  callbacks.stop({ tempFilePath: "a.mp3", duration: 2000 });
  const res = await p;
  assert.equal(res.tempFilePath, "a.mp3");
  assert.equal(res.durationMs, 2000);
});
