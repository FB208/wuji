/** 处理中遮罩：保留背景，中心显示状态文案，禁止重复操作（文档 8.2）。 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    text: { type: String, value: "" },
    /** error 状态显示重试按钮 */
    error: { type: Boolean, value: false },
    retryText: { type: String, value: "重新提交" },
  },
  methods: {
    onRetry() {
      this.triggerEvent("retry");
    },
    noop() {
      // 拦截穿透点击
    },
  },
});
