Component({
  properties: {
    item: { type: Object, value: {} },
    /** big：查找结果卡，位置文字最醒目（文档 8.3） */
    mode: { type: String, value: "list" }, // list | big
  },
  data: {
    imageFailed: false,
  },
  methods: {
    onTap() {
      this.triggerEvent("tap", { item: this.data.item });
    },
    onImageError() {
      // 图片加载失败显示灰色占位块，位置文字仍可查看（文档 14.1）
      this.setData({ imageFailed: true });
    },
  },
});
