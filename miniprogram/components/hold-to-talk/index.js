/** 按住说话：按下开始录音，上滑取消，松开提交（文档 4.2 / 8.2）。 */
const { recorder } = require("../../services/recorder");

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
      this._visible = false;
      this.interrupt();
    },
    show() {
      this._visible = true;
    },
  },
  lifetimes: {
    attached() {
      this._visible = true;
    },
    detached() {
      this._visible = false;
      this.interrupt();
    },
  },
  methods: {
    clearTimer() {
      const timer = this._timer;
      if (timer !== undefined && timer !== null) {
        clearInterval(timer);
        this._timer = null;
      }
    },
    bump() {
      this._gen = (this._gen || 0) + 1;
      return this._gen;
    },
    alive(gen) {
      return this._gen === gen && this._visible !== false && !this.data.disabled;
    },
    interrupt() {
      this._pressed = false;
      this._started = false;
      const pending = this._pending;
      this.bump();
      this.clearTimer();
      if (this.data.recording) {
        this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      }
      if (pending) {
        this._pending = null;
        recorder.stop(true, pending).catch(() => {});
      }
    },
    async onTouchStart(e) {
      if (this.data.disabled || this.data.recording || this._pending) return;
      const gen = this.bump();
      this._pressed = true;
      this._started = false;
      this._startY = e.touches[0].clientY;
      // 按下即反馈：权限检查和录音机初始化在后台进行
      this.setData({ recording: true, starting: true, willCancel: false, seconds: 0 });
      this.triggerEvent("recordstart");
      const granted = await recorder.requestPermission();
      if (!this.alive(gen)) return;
      if (!this._pressed) {
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
        if (!this.alive(gen) || !this._pressed) {
          recorder.stop(true, promise).catch(() => {});
          return;
        }
        this._started = true;
        this.setData({ starting: false });
        this.triggerEvent("recordready");
        this.clearTimer();
        this._timer = setInterval(() => {
          this.setData({ seconds: this.data.seconds + 1 });
        }, 1000);
      });
      this._pending = promise;
      promise
        .then((result) => {
          if (!this.alive(gen)) return;
          this.clearTimer();
          if (result === null) {
            this.triggerEvent("recordcancel");
          } else {
            this.triggerEvent("recordfinish", { tempFilePath: result.tempFilePath });
          }
        })
        .catch((err) => {
          if (!this.alive(gen)) return;
          this.clearTimer();
          this.triggerEvent("recorderror", { message: err.message });
        })
        .finally(() => {
          if (this._pending === promise) this._pending = null;
          if (this._gen === gen) {
            this.setData({ recording: false, starting: false, willCancel: false });
          }
        });
    },
    onTouchMove(e) {
      if (!this.data.recording) return;
      const startY = this._startY;
      const willCancel = startY - e.touches[0].clientY > CANCEL_DISTANCE;
      if (willCancel !== this.data.willCancel) {
        this.setData({ willCancel });
        this.triggerEvent("recordmove", { willCancel });
      }
    },
    onTouchEnd() {
      this._pressed = false;
      const pending = this._pending;
      // 录音机尚未就绪时松开视为取消；onStart 回调会因 !_pressed 自动取消
      const cancel = this.data.willCancel || !this._started;
      this.clearTimer();
      this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      if (pending && this._started) {
        recorder.stop(cancel, pending).catch(() => {});
      }
    },
    onTouchCancel() {
      this._pressed = false;
      const pending = this._pending;
      this.clearTimer();
      this.setData({ recording: false, starting: false, willCancel: false, seconds: 0 });
      if (pending && this._started) {
        recorder.stop(true, pending).catch(() => {});
      }
    },
  },
});
