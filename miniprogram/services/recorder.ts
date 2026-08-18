/** 录音封装：按住说话，1～60 秒，mp3 格式（文档 1.4 / 11.3）。 */

export interface RecordResult {
  tempFilePath: string;
  durationMs: number;
}

const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 60000;

type StopReason = "submit" | "cancel";

class Recorder {
  private manager = wx.getRecorderManager();
  private startedAt = 0;
  private stopReason: StopReason = "submit";
  private resolveStop: ((r: RecordResult | null) => void) | null = null;
  private rejectStop: ((e: Error) => void) | null = null;

  constructor() {
    this.manager.onStop((res) => {
      const resolve = this.resolveStop;
      const reject = this.rejectStop;
      this.resolveStop = null;
      this.rejectStop = null;
      if (!resolve || !reject) return;
      if (this.stopReason === "cancel") {
        resolve(null);
        return;
      }
      const duration = Date.now() - this.startedAt;
      if (duration < MIN_DURATION_MS) {
        reject(new Error("录音太短，请重新录入"));
        return;
      }
      resolve({ tempFilePath: res.tempFilePath, durationMs: duration });
    });
    this.manager.onError(() => {
      const reject = this.rejectStop;
      this.resolveStop = null;
      this.rejectStop = null;
      if (reject) reject(new Error("录音失败，请重试"));
    });
  }

  /** 请求麦克风权限；被拒绝时返回 false（页面提供文字降级，文档 14.1）。 */
  async requestPermission(): Promise<boolean> {
    try {
      const setting = await wx.getSetting();
      if (setting.authSetting["scope.record"]) return true;
      await wx.authorize({ scope: "scope.record" });
      return true;
    } catch (_) {
      return false;
    }
  }

  start() {
    this.startedAt = Date.now();
    this.stopReason = "submit";
    this.manager.start({
      duration: MAX_DURATION_MS,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
    });
  }

  /** 结束录音。cancel=true 表示上滑取消，不提交。 */
  stop(cancel = false): Promise<RecordResult | null> {
    this.stopReason = cancel ? "cancel" : "submit";
    return new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
      this.manager.stop();
    });
  }
}

export const recorder = new Recorder();
