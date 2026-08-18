/** P04 查找物品：语音多轮查找 + 文字降级（文档 5 章 / 8.3）。 */
import { uploadFile, request, ApiError, API_BASE_URL } from "../../services/api";
import { store } from "../../store/index";

interface SearchResult {
  transcript: string | null;
  status: "found" | "multiple" | "not_found";
  prompt: string | null;
  items: { id: number; name: string; location_text: string; image_url: string }[];
}

interface Turn {
  query: string;
  status?: string;
  item_ids?: number[];
  excluded_item_ids?: number[];
}

const MAX_TURNS = 6;

type UiState = "ready" | "searching" | "found" | "multiple" | "not_found" | "error";

Page({
  data: {
    state: "ready" as UiState,
    items: [] as SearchResult["items"],
    prompt: "",
    lastQuery: "",
    showTextInput: false,
    textQuery: "",
  },
  // 对话上下文只保存在页面内存中（文档 5.5）
  _turns: [] as Turn[],

  onUnload() {
    // 离开页面即结束本次对话
    this._turns = [];
  },
  onClear() {
    this._turns = [];
    this.setData({ state: "ready", items: [], prompt: "", lastQuery: "" });
  },
  onPermissionDenied() {
    // 麦克风不可用时使用文字（文档 5.3 / 14.1）
    this.setData({ showTextInput: true });
    wx.showToast({ title: "麦克风不可用，可输入文字查找", icon: "none" });
  },
  onRecordError(e: WechatMiniprogram.CustomEvent) {
    wx.showToast({ title: e.detail.message || "录音失败，请重试", icon: "none" });
  },
  toggleTextInput() {
    this.setData({ showTextInput: !this.data.showTextInput });
  },
  onTextInput(e: WechatMiniprogram.Input) {
    this.setData({ textQuery: e.detail.value });
  },
  onTextSubmit() {
    const query = this.data.textQuery.trim();
    if (!query) return;
    this.setData({ textQuery: "" });
    this.searchByText(query);
  },

  buildContext(): { turns: Turn[] } {
    return { turns: this._turns.slice(-MAX_TURNS) };
  },
  applyResult(query: string, result: SearchResult) {
    this._turns.push({
      query,
      status: result.status,
      item_ids: result.items.map((i) => i.id),
    });
    this._turns = this._turns.slice(-MAX_TURNS);
    this.setData({
      state: result.status,
      items: result.items,
      prompt: result.prompt || (result.status === "not_found" ? "未找到记录，可换个说法。" : ""),
      lastQuery: query,
    });
  },
  handleError(err: unknown) {
    const message = err instanceof ApiError ? err.message : "查找失败，请重试";
    this.setData({ state: "error", prompt: message });
  },

  async onRecordFinish(e: WechatMiniprogram.CustomEvent) {
    this.setData({ state: "searching" });
    try {
      const result = await uploadFile<SearchResult>({
        path: "/items/search/audio",
        filePath: e.detail.tempFilePath,
        name: "audio",
        formData: {
          family_id: store.currentFamilyId,
          context_json: JSON.stringify(this.buildContext()),
        },
      });
      this.applyResult(result.transcript || "", result);
    } catch (err) {
      this.handleError(err);
    }
  },
  async searchByText(query: string) {
    this.setData({ state: "searching" });
    try {
      const result = await request<SearchResult>({
        path: "/items/search/text",
        method: "POST",
        data: {
          family_id: store.currentFamilyId,
          query,
          context: this.buildContext(),
        },
      });
      this.applyResult(query, result);
    } catch (err) {
      this.handleError(err);
    }
  },
  onRetry() {
    if (this.data.lastQuery) {
      this.searchByText(this.data.lastQuery);
    } else {
      this.setData({ state: "ready", prompt: "" });
    }
  },
  onItemTap(e: WechatMiniprogram.CustomEvent) {
    const item = e.detail.item;
    wx.navigateTo({ url: `/pages/item-detail/index?id=${item.id}` });
  },
});
