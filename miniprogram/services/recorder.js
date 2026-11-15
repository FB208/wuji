/** 录音封装：按住说话，1～60 秒，mp3 格式（文档 1.4 / 11.3）。 */

const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60000;
const STOP_WATCHDOG_MS = 5000;

class Recorder {
  manager = wx.getRecorderManager();
  session = null;

  constructor() {
    this.manager.onStart(() => {
      const s = this.session;
      if (!s || s.settled) return;
      s.startedAt = Date.now();
      if (s.onStarted) s.onStarted();
    });
    this.manager.onStop((res) => {
      const s = this.session;
      if (!s) return;
      s.awaitingAck = false;
      if (s.settled) return;
      this.finish(s);
      if (s.reason === "cancel") {
        s.resolve(null);
        return;
      }
      const duration = res.duration === undefined
        ? s.startedAt === null ? 0 : Date.now() - s.startedAt
        : res.duration;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < MIN_DURATION_MS) {
        s.reject(new Error("录音太短，请重新录入"));
        return;
      }
      if (duration > MAX_DURATION_MS) {
        s.reject(new Error("录音超过60秒，请重新录入"));
        return;
      }
      if (!res.tempFilePath) {
        s.reject(new Error("录音失败，请重试"));
        return;
      }
      s.resolve({ tempFilePath: res.tempFilePath, durationMs: duration });
    });
    this.manager.onError((res) => {
      console.warn("recorder错误", res);
      const s = this.session;
      if (!s) return;
      s.awaitingAck = false;
      if (s.settled) return;
      this.finish(s);
      s.reject(new Error("录音失败，请重试"));
    });
    this.manager.onInterruptionBegin(() => {
      const s = this.session;
      if (!s || s.settled) return;
      this.requestStop(s, true);
    });
  }

  finish(s) {
    s.settled = true;
    if (s.watchdog !== null) {
      clearTimeout(s.watchdog);
      s.watchdog = null;
    }
  }

  requestStop(s, cancel) {
    if (cancel) s.reason = "cancel";
    if (s.awaitingAck) return;
    s.awaitingAck = true;
    s.watchdog = setTimeout(() => {
      if (!s.settled) {
        this.finish(s);
        s.reject(new Error("录音停止超时，请重试"));
      }
    }, STOP_WATCHDOG_MS);
    try {
      this.manager.stop();
    } catch (err) {
      this.finish(s);
      s.reject(err instanceof Error ? err : new Error("录音停止失败"));
    }
  }

  /** 请求麦克风权限；被拒绝时返回 false（页面提供文字降级，文档 14.1）。 */
  async requestPermission() {
    try {
      const setting = await wx.getSetting();
      if (setting.authSetting["scope.record"]) return true;
      await wx.authorize({ scope: "scope.record" });
      return true;
    } catch (err) {
      console.warn("录音权限申请失败", err);
      return false;
    }
  }

  start(onStarted) {
    if (this.session && (!this.session.settled || this.session.awaitingAck)) {
      return Promise.reject(new Error("上一段录音尚未结束"));
    }
    let resolveFn = () => {};
    let rejectFn = () => {};
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const session = {
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      startedAt: null,
      reason: "submit",
      settled: false,
      awaitingAck: false,
      watchdog: null,
      onStarted,
    };
    this.session = session;
    try {
      this.manager.start({
        duration: MAX_DURATION_MS,
        format: "mp3",
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
      });
    } catch (err) {
      this.finish(session);
      session.reject(err instanceof Error ? err : new Error("录音启动失败"));
    }
    return promise;
  }

  /** 结束录音。cancel=true 表示上滑取消，不提交。 */
  stop(cancel = false, expectedPromise) {
    const s = this.session;
    if (!s) return Promise.resolve(null);
    if (expectedPromise && expectedPromise !== s.promise) return Promise.resolve(null);
    if (s.settled) return s.promise;
    this.requestStop(s, cancel);
    return s.promise;
  }
}

const recorder = new Recorder();

module.exports = { recorder };
