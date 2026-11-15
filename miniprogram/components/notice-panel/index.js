/** 全局提示弹窗：brutal 风格遮罩卡片，确认/取消按钮，可选输入框。 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: "" },
    text: { type: String, value: "" },
    secondaryText: { type: String, value: "" },
    confirmText: { type: String, value: "知道了" },
    cancelText: { type: String, value: "" },
    editable: { type: Boolean, value: false },
    placeholderText: { type: String, value: "" },
  },
  data: {
    inputValue: "",
  },
  observers: {
    visible(v) {
      if (v) this.setData({ inputValue: "" });
    },
  },
  methods: {
    onInput(e) {
      this.setData({ inputValue: e.detail.value });
    },
    onConfirm() {
      this.triggerEvent("confirm", { value: this.data.inputValue });
    },
    onCancel() {
      this.triggerEvent("cancel");
    },
    noop() {},
  },
});
