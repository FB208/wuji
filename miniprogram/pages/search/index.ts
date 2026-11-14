/** P04 查找物品：语音多轮查找 + 文字降级（文档 5 章 / 8.3）。 */
import { uploadFile, request, ApiError } from "../../services/api";
import { ensureLogin, refreshMe } from "../../services/auth";
import { PageScope, ScopeOperation } from "../../services/page-scope";
import { store, Scope } from "../../store/index";

interface SearchItem {
  id: number;
  name: string;
  location_text: string;
  image_url: string;
}

interface SearchTurn {
  query: string;
  status?: string | null;
  item_ids?: number[];
}

interface SearchContext {
  family_id?: number;
  initial_query?: string | null;
  turns?: SearchTurn[];
  shown_item_ids?: number[];
  excluded_item_ids?: number[];
  last_item_ids?: number[];
  last_status?: string | null;
}

interface SearchResult {
  transcript: string | null;
  status: "found" | "multiple" | "not_found";
  prompt: string | null;
  items: SearchItem[];
  context: SearchContext;
}

type Pending =
  | { kind: "text"; query: string; scope: Scope; context: SearchContext }
  | { kind: "audio"; filePath: string; scope: Scope; context: SearchContext }
  | null;

type UiState = "ready" | "searching" | "found" | "multiple" | "not_found" | "error";

function freezeCopy<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = (part: any): void => {
    if (part && typeof part === "object") {
      Object.values(part).forEach(freeze);
      Object.freeze(part);
    }
  };
  freeze(copy);
  return copy;
}

Page({
  data: {
    state: "ready" as UiState,
    ready: false,
    busy: false,
    noFamily: false,
    items: [] as SearchItem[],
    prompt: "",
    lastQuery: "",
    showTextInput: false,
    textQuery: "",
    context: null as SearchContext | null,
  },
  // 对话上下文只保存在页面内存中（文档 5.5）
  _guard: null as PageScope | null,
  _sessionScope: null as Scope | null,
  _resultScope: null as Scope | null,
  _pending: null as Pending,
  _authFailed: false,

  onLoad() {
    this._guard = new PageScope();
  },
  onShow() {
    const guard = this._guard as PageScope;
    guard.show();
    this.resumeAuth();
  },
  async resumeAuth() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    const frame = guard.frame();
    const recoveringAuth = this._authFailed;
    this._authFailed = false;
    this.setData({ busy: true, ready: false });
    try {
      await ensureLogin();
    } catch (err) {
      if (!guard.isFrameCurrent(frame)) return;
      this._authFailed = true;
      this._sessionScope = null;
      this.setData({
        busy: false,
        ready: false,
        items: [],
        prompt: "",
        lastQuery: "",
        context: null,
        state: "error",
      });
      if (err instanceof ApiError && err.code === "LOGIN_BLOCKED") {
        wx.reLaunch({ url: "/pages/launch/index" });
        return;
      }
      this.setData({ prompt: "登录失败，请重试" });
      return;
    }
    if (!guard.isFrameCurrent(frame)) return;
    const scope = store.captureScope();
    this._sessionScope = scope.userId ? scope : null;
    this._authFailed = !scope.userId;
    const authState = { busy: false, ready: !!scope.userId && !!scope.familyId, noFamily: !!scope.userId && !scope.familyId };
    const staleResult =
      this._resultScope &&
      (this._resultScope.userId !== scope.userId ||
        this._resultScope.familyId !== scope.familyId ||
        this._resultScope.version !== scope.version);
    const stalePending =
      this._pending &&
      (this._pending.scope.userId !== scope.userId ||
        this._pending.scope.familyId !== scope.familyId ||
        this._pending.scope.version !== scope.version);
    if (staleResult || stalePending) {
      this._resultScope = null;
      this._pending = null;
      this.setData({
        ...authState,
        state: "ready",
        items: [],
        prompt: "",
        lastQuery: "",
        context: null,
        textQuery: "",
      });
    } else {
      const interrupted = this.data.state === "searching";
      const recovered = recoveringAuth && !this._pending;
      this.setData({
        ...authState,
        state: interrupted ? "error" : recovered ? "ready" : this.data.state,
        prompt: interrupted ? this._pending ? "请求已中断，可重试" : "请求已中断" : recovered ? "" : this.data.prompt,
      });
    }
  },
  onHide() {
    const guard = this._guard as PageScope;
    guard.hide();
    const holder = (this as any).selectComponent && (this as any).selectComponent("#h2t");
    if (holder && holder.interrupt) holder.interrupt();
  },
  // 离开页面即结束本次对话
  onUnload() {
    this.onHide();
    this._pending = null;
    this._resultScope = null;
  },

  session(): Scope | null {
    const guard = this._guard as PageScope;
    if (!guard || !guard.isFrameCurrent(guard.frame())) return null;
    return this.data.ready && !this.data.busy && this._sessionScope && store.isCurrentScope(this._sessionScope)
      ? this._sessionScope : null;
  },

  onClear() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame())) return;
    guard.invalidate();
    const holder = (this as any).selectComponent && (this as any).selectComponent("#h2t");
    if (holder && holder.interrupt) holder.interrupt();
    this._pending = null;
    this._resultScope = null;
    this.setData({
      state: "ready",
      items: [],
      prompt: "",
      lastQuery: "",
      context: null,
      textQuery: "",
    });
    if (!this.session()) {
      this.resumeAuth();
    }
  },
  onPermissionDenied() {
    if (!this.session() || this.data.state === "searching") return;
    // 麦克风不可用时使用文字（文档 5.3 / 14.1）
    this.setData({ showTextInput: true });
    wx.showToast({ title: "麦克风不可用，可输入文字查找", icon: "none" });
  },
  onRecordError(e: WechatMiniprogram.CustomEvent) {
    if (!this.session() || this.data.state === "searching") return;
    wx.showToast({ title: e.detail.message || "录音失败，请重试", icon: "none" });
  },
  toggleTextInput() {
    if (!this.session() || this.data.state === "searching") return;
    this.setData({ showTextInput: !this.data.showTextInput });
  },
  onTextInput(e: WechatMiniprogram.Input) {
    if (!this.session() || this.data.state === "searching") return;
    this.setData({ textQuery: e.detail.value });
  },
  onTextSubmit() {
    if (!this.session() || this.data.busy || !this.data.ready) return;
    if (this.data.state === "searching") return;
    const query = this.data.textQuery.trim();
    if (!query || query.length > 512) {
      wx.showToast({ title: query ? "输入过长" : "请输入查找内容", icon: "none" });
      return;
    }
    this.setData({ textQuery: "" });
    this.submitText(query);
  },

  buildContext(): SearchContext {
    const ctx = this.data.context;
    if (this._resultScope && ctx && this._sessionScope && store.isCurrentScope(this._resultScope)) {
      return JSON.parse(JSON.stringify(ctx));
    }
    return { family_id: this._sessionScope ? this._sessionScope.familyId : 0 };
  },
  applyResult(query: string, result: SearchResult, op: ScopeOperation) {
    this._resultScope = op.scope;
    this._pending = null;
    this.setData({
      state: result.status,
      items: result.items,
      prompt: result.prompt || (result.status === "not_found" ? "未找到记录，可换个说法。" : ""),
      lastQuery: query,
      context: result.context ? JSON.parse(JSON.stringify(result.context)) : null,
    });
  },
  handleScopeChanged(op: ScopeOperation): boolean {
    const guard = this._guard as PageScope;
    if (!guard.scopeChanged(op)) return false;
    guard.invalidate();
    const scope = store.captureScope();
    this._sessionScope = scope.userId ? scope : null;
    this._authFailed = !scope.userId;
    this._pending = null;
    this._resultScope = null;
    this.setData({
      state: "ready",
      items: [],
      prompt: "家庭已切换，请重新查找",
      lastQuery: "",
      context: null,
      textQuery: "",
      busy: false,
      ready: !!scope.userId && !!scope.familyId,
      noFamily: !!scope.userId && !scope.familyId,
    });
    return true;
  },
  async handleError(err: unknown, op: ScopeOperation) {
    if (this.handleScopeChanged(op)) return;
    const guard = this._guard as PageScope;
    if (!guard.isCurrent(op)) return;
    if (err instanceof ApiError && err.statusCode === 403) {
      try {
        await refreshMe();
      } catch (_) {}
      if (this.handleScopeChanged(op)) return;
      if (!guard.isCurrent(op)) return;
    }
    if (err instanceof ApiError && !err.retryable) {
      this._pending = null;
    }
    const message = err instanceof ApiError ? err.message : "查找失败，请重试";
    this.setData({ state: "error", prompt: message });
  },

  submitText(query: string) {
    const session = this.session();
    if (!session || this.data.state === "searching") return;
    if (!query.trim() || query.length > 512) return;
    const context = this.buildContext();
    this._pending = freezeCopy<Exclude<Pending, null>>({ kind: "text", query, scope: session, context });
    this.runPending(this._pending);
  },
  onRecordFinish(e: WechatMiniprogram.CustomEvent) {
    if (!this.session() || this.data.busy || !this.data.ready) return;
    if (this.data.state === "searching") return;
    if (!this._sessionScope!.familyId) {
      this.setData({ noFamily: true });
      return;
    }
    const context = this.buildContext();
    if (typeof e.detail.tempFilePath !== "string" || !e.detail.tempFilePath) return;
    this._pending = freezeCopy<Exclude<Pending, null>>({ kind: "audio", filePath: e.detail.tempFilePath, scope: this._sessionScope!, context });
    this.runPending(this._pending);
  },
  async runPending(p: Exclude<Pending, null>) {
    const guard = this._guard as PageScope;
    if (!this.session() || this.data.state === "searching" || !store.isCurrentScope(p.scope)) return;
    guard.invalidate();
    const op = guard.capture();
    if (!guard.isCurrent(op) || !store.isCurrentScope(p.scope)) {
      return;
    }
    const context = freezeCopy(p.context);
    this.setData({ state: "searching" });
    try {
      const result = await guard.run<SearchResult>(op, (hooks) => {
        if (p.kind === "text") {
          return request<SearchResult>({
            path: "/items/search/text",
            method: "POST",
            data: {
              family_id: op.scope.familyId,
              query: p.query,
              context,
            },
            isCancelled: hooks.isCancelled,
            onTask: hooks.onTask,
          });
        }
        return uploadFile<SearchResult>({
          path: "/items/search/audio",
          filePath: p.filePath,
          name: "audio",
          formData: {
            family_id: op.scope.familyId,
            context_json: JSON.stringify(context),
          },
          isCancelled: hooks.isCancelled,
          onTask: hooks.onTask,
        });
      });
      if (this.handleScopeChanged(op)) return;
      if (!guard.isCurrent(op)) return;
      this.applyResult(p.kind === "text" ? p.query : result.transcript || "", result, op);
    } catch (err) {
      await this.handleError(err, op);
    }
  },
  onExclude(e: WechatMiniprogram.CustomEvent) {
    if (!this.session() || !this._resultScope || !store.isCurrentScope(this._resultScope) || this.data.state === "searching") return;
    const id = Number(e.currentTarget.dataset.id);
    const shown = this.data.items.map((i) => i.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !shown.includes(id)) return;
    const ctx = this.data.context || {};
    const excluded = Array.from(new Set([...(ctx.excluded_item_ids || []), id]));
    const newCtx: SearchContext = {
      ...JSON.parse(JSON.stringify(ctx)),
      excluded_item_ids: excluded,
    };
    this.setData({ context: newCtx });
    this.submitText("继续查找");
  },
  onRetry() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || this.data.state === "searching") return;
    if (this._authFailed || !this._sessionScope) {
      this.resumeAuth();
      return;
    }
    if (!this.session()) return;
    const pending = this._pending;
    if (!pending) {
      this.setData({ state: "ready", prompt: "" });
      return;
    }
    if (!store.isCurrentScope(pending.scope)) return;
    this.runPending(pending);
  },
  onItemTap(e: WechatMiniprogram.CustomEvent) {
    if (!this.session() || !this._resultScope || !store.isCurrentScope(this._resultScope)) return;
    const item = e.detail.item;
    if (!item || !this.data.items.some((i) => i.id === item.id)) return;
    wx.navigateTo({ url: `/pages/item-detail/index?id=${item.id}` });
  },
  goHome() {
    const guard = this._guard as PageScope;
    if (!guard.isFrameCurrent(guard.frame()) || this.data.busy || !this._sessionScope || !store.isCurrentScope(this._sessionScope)) return;
    wx.switchTab({ url: "/pages/home/index" });
  },
});
