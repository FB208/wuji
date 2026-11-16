/** 收纳和查找共用的底部输入栏，统一输入模式、录音事件和键盘避让。 */
Component({
  properties: {
    value: { type: String, value: "" },
    placeholder: { type: String, value: "" },
    submitText: { type: String, value: "发送" },
    idleText: { type: String, value: "按住说话" },
    maxlength: { type: Number, value: 512 },
    confirmType: { type: String, value: "send" },
    disabled: { type: Boolean, value: false },
    submitDisabled: { type: Boolean, value: false },
    visible: { type: Boolean, value: true },
  },
  data: {
    showTextInput: false,
    recording: false,
    keyboardHeight: 0,
  },
  observers: {
    /** 输入被禁用或隐藏时结束当前交互。 */
    "disabled, visible"(disabled, visible) {
      if (disabled || !visible) {
        this.interrupt();
        this.closeKeyboard();
      }
    },
    /** 仅禁用发送时仍可编辑草稿，录音需要暂停。 */
    submitDisabled(disabled) {
      if (disabled) this.interrupt();
    },
  },
  pageLifetimes: {
    /** 页面离开时停止录音并清除键盘占位。 */
    hide() {
      this.interrupt();
      this.setData({ keyboardHeight: 0 });
    },
  },
  methods: {
    /** 在两种输入模式间切换，文字草稿由页面保留。 */
    toggleMode() {
      this.closeKeyboard();
      this.setData({ showTextInput: !this.data.showTextInput });
    },
    /** 允许页面在麦克风不可用时选择文字输入。 */
    useTextInput() {
      this.setData({ showTextInput: true });
    },
    /** 把文字更新交给页面保存。 */
    onInput(e) {
      this.triggerEvent("input", { value: e.detail.value });
    },
    /** 点击按钮和键盘确认共用提交入口。 */
    onSubmit() {
      if (this.data.disabled || this.data.submitDisabled || this.data.recording) return;
      this.triggerEvent("submit", { value: this.data.value });
    },
    /** 根据实际键盘高度调整底部位置。 */
    onKeyboardHeightChange(e) {
      this.setData({
        keyboardHeight: this.data.showTextInput && this.data.visible && !this.data.disabled ? e.detail.height : 0,
      });
    },
    /** 收起键盘并归位输入栏。 */
    closeKeyboard() {
      if (this.data.keyboardHeight > 0) wx.hideKeyboard();
      this.setData({ keyboardHeight: 0 });
    },
    /** 统一维护录音交互状态并转发业务所需的录音事件。 */
    onRecordEvent(e) {
      if (e.type === "recordstart") this.setData({ recording: true });
      if (["recordfinish", "recordcancel", "recorderror", "permissiondenied"].includes(e.type)) {
        this.setData({ recording: false });
      }
      this.triggerEvent(e.type, e.detail);
    },
    /** 供页面清空或离开时中断内部录音。 */
    interrupt() {
      const holder = this.selectComponent("#recorder");
      if (holder) holder.interrupt();
      const recording = this.data.recording;
      this.setData({ recording: false });
      if (recording) this.triggerEvent("recordcancel");
    },
  },
});
