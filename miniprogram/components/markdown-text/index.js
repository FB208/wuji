const { markdownNodes } = require("../../utils/markdown");

Component({
  properties: {
    content: { type: String, value: "" },
  },
  data: { nodes: [] },
  observers: {
    /** 消息或流式草稿更新时重新生成富文本节点。 */
    content(value) {
      this.setData({ nodes: markdownNodes(value) });
    },
  },
});
