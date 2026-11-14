/** 按住说话：按下开始录音，上滑取消，松开提交（文档 4.2 / 8.2）。 */
import { recorder, RecordResult } from "../../services/recorder";

const CANCEL_DISTANCE = 80;

Component({
  properties: {
    idleText: { type: String, value: "按住说话" },
    compact: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
  },
  data: {
    recording: false,
    starting: false,
    willCancel: false,
    seconds: 0,
  },
  pageLifetimes: {
    hide() {
      (this as any)._visible = false;
      this.interrupt();
    },
    show() {
      (this as any)._visible = true;
    },
  },
  lifetimes: {
    attached() {
      (this as any)._visible = true;
    },
    detached() {
      (this as any)._visible = false;
      this.interrupt();
    },
  },
  methods: {
    clearTimer() {
      const timer = (this as any)._timer;
      if (timer !== undefined && timer !== null) {
        clearInterval(timer);
        (this as any)._timer = null;
      }
    },
    bump(): number {
      (this as any)._gen = ((this as any)._gen || 0) + 1;
      return (this as any)._gen;
    },
    alive(gen: number): boolean {
      return (this as any)._gen === gen && (this as any)._visible !== false && !this.data.disabled;
    },
    interrupt() {
      (this as any)._pressed = false;
      (this as any)._started = false;
      const pending = (this as any)._pending as Promise<RecordResult | null> | undefined;
      this.bump();
      this.clearTimer();
      if (this.data.recording) {
        this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      }
      if (pending) {
        (this as any)._pending = null;
        recorder.stop(true, pending).catch(() => {});
      }
    },
    async onTouchStart(e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled || this.data.recording || (this as any)._pending) return;
      const gen = this.bump();
      (this as any)._pressed = true;
      (this as any)._started = false;
      (this as any)._startY = e.touches[0].clientY;
      // 按下即反馈：权限检查和录音机初始化在后台进行
      this.setData({ recording: true, starting: true, willCancel: false, seconds: 0 });
      this.triggerEvent("recordstart");
      const granted = await recorder.requestPermission();
      if (!this.alive(gen)) return;
      if (!(this as any)._pressed) {
        this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
        this.triggerEvent("recordcancel");
        return;
      }
      if (!granted) {
        this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
        this.triggerEvent("permissiondenied");
        return;
      }
      const promise = recorder.start(() => {
        if (!this.alive(gen) || !(this as any)._pressed) {
          recorder.stop(true, promise).catch(() => {});
          return;
        }
        (this as any)._started = true;
        this.setData({ starting: false });
        this.triggerEvent("recordready");
        this.clearTimer();
        (this as any)._timer = setInterval(() => {
          this.setData({ seconds: this.data.seconds + 1 });
        }, 1000);
      });
      (this as any)._pending = promise;
      promise
        .then((result: RecordResult | null) => {
          if (!this.alive(gen)) return;
          this.clearTimer();
          if (result === null) {
            this.triggerEvent("recordcancel");
          } else {
            this.triggerEvent("recordfinish", { tempFilePath: result.tempFilePath });
          }
        })
        .catch((err: Error) => {
          if (!this.alive(gen)) return;
          this.clearTimer();
          this.triggerEvent("recorderror", { message: err.message });
        })
        .finally(() => {
          if ((this as any)._pending === promise) (this as any)._pending = null;
          if ((this as any)._gen === gen) {
            this.setData({ recording: false, starting: false, willCancel: false });
          }
        });
    },
    onTouchMove(e: WechatMiniprogram.TouchEvent) {
      if (!this.data.recording) return;
      const startY = (this as any)._startY as number;
      const willCancel = startY - e.touches[0].clientY > CANCEL_DISTANCE;
      if (willCancel !== this.data.willCancel) {
        this.setData({ willCancel });
        this.triggerEvent("recordmove", { willCancel });
      }
    },
    onTouchEnd() {
      (this as any)._pressed = false;
      const pending = (this as any)._pending as Promise<RecordResult | null> | undefined;
      // 录音机尚未就绪时松开视为取消；onStart 回调会因 !_pressed 自动取消
      const cancel = this.data.willCancel || !(this as any)._started;
      this.clearTimer();
      this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      if (pending && (this as any)._started) {
        recorder.stop(cancel, pending).catch(() => {});
      }
    },
    onTouchCancel() {
      (this as any)._pressed = false;
      const pending = (this as any)._pending as Promise<RecordResult | null> | undefined;
      this.clearTimer();
      this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      if (pending && (this as any)._started) {
        recorder.stop(true, pending).catch(() => {});
      }
    },
  },
});
