/** 按住说话：按下开始录音，上滑取消，松开提交（文档 4.2 / 8.2）。 */
import { recorder } from "../../services/recorder";

const CANCEL_DISTANCE = 80;

Component({
  properties: {
    idleText: { type: String, value: "按住说话" },
    disabled: { type: Boolean, value: false },
  },
  data: {
    recording: false,
    willCancel: false,
    seconds: 0,
  },
  lifetimes: {
    detached() {
      this.clearTimer();
    },
  },
  methods: {
    clearTimer() {
      const timer = (this as any)._timer;
      if (timer) {
        clearInterval(timer);
        (this as any)._timer = null;
      }
    },
    async onTouchStart(e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled || this.data.recording) return;
      const granted = await recorder.requestPermission();
      if (!granted) {
        this.triggerEvent("permissiondenied");
        return;
      }
      (this as any)._startY = e.touches[0].clientY;
      this.setData({ recording: true, willCancel: false, seconds: 0 });
      recorder.start();
      this.triggerEvent("recordstart");
      (this as any)._timer = setInterval(() => {
        this.setData({ seconds: this.data.seconds + 1 });
      }, 1000);
    },
    onTouchMove(e: WechatMiniprogram.TouchEvent) {
      if (!this.data.recording) return;
      const startY = (this as any)._startY as number;
      const willCancel = startY - e.touches[0].clientY > CANCEL_DISTANCE;
      if (willCancel !== this.data.willCancel) {
        this.setData({ willCancel });
      }
    },
    async onTouchEnd() {
      if (!this.data.recording) return;
      this.clearTimer();
      const cancel = this.data.willCancel;
      this.setData({ recording: false, willCancel: false, seconds: 0 });
      try {
        const result = await recorder.stop(cancel);
        if (result === null) {
          this.triggerEvent("recordcancel");
        } else {
          this.triggerEvent("recordfinish", { tempFilePath: result.tempFilePath });
        }
      } catch (err) {
        this.triggerEvent("recorderror", { message: (err as Error).message });
      }
    },
  },
});
