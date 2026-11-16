import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  convertToLlm,
  serializeConversation,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { COMPACTION_PROMPT, SYSTEM_PROMPT } from "./prompts.js";
import { logEvent } from "./logging.js";
import type {
  ChatMessage, ChatProgress, HistoryResult, MessageBlock, RunTurnRequest, TurnResult,
} from "./types.js";

const appDirectory = process.cwd();
const dataDirectory = path.resolve(process.env.AGENT_DATA_DIR!);
mkdirSync(dataDirectory, { recursive: true });

// 配置仅在服务启动时校验，内部直接使用指定模型，不自动选模型。
for (const name of ["SEMANTIC_BASE_URL", "SEMANTIC_MODEL", "SEMANTIC_API_KEY"]) {
  if (!process.env[name]) throw new Error(`缺少 Agent 配置：${name}`);
}
const contextWindow = Number(process.env.AGENT_CONTEXT_WINDOW);
const maxTokens = Number(process.env.AGENT_MAX_TOKENS);
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(dataDirectory, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerProvider("wuji", {
  baseUrl: process.env.SEMANTIC_BASE_URL!,
  api: "openai-completions",
  models: [{
    id: process.env.SEMANTIC_MODEL!,
    name: process.env.SEMANTIC_MODEL!,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }],
});
await modelRuntime.setRuntimeApiKey("wuji", process.env.SEMANTIC_API_KEY!);
const model = modelRuntime.getModel("wuji", process.env.SEMANTIC_MODEL!)!;

/** 从原始条目生成展示消息，发送结果与历史分页共用此转换。 */
function toChatMessages(entries: SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    let role: "user" | "assistant" = "assistant";
    let blocks: MessageBlock[] = [];
    if (entry.type === "custom" && entry.customType === "chat_error") {
      blocks = [{ type: "error", message: (entry.data as { message: string }).message }];
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user" || message.role === "assistant") {
        role = message.role;
        // 失败的助手输出由 chat_error 表达，不展示未完成的回答。
        if (message.role === "assistant" &&
            (message.stopReason === "error" || message.stopReason === "aborted")) continue;
        const content = typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
        blocks = content
          .filter((part) => part.type === "text" && part.text.trim())
          .map((part) => ({ type: "text", text: (part as { text: string }).text }));
      } else if (message.role === "toolResult" &&
                 message.toolName === "show_items" && !message.isError) {
        blocks = [message.details as Extract<MessageBlock, { type: "item_cards" }>];
      }
    }
    if (blocks.length) {
      messages.push({ id: entry.id, role, created_at: entry.timestamp, blocks });
    }
  }
  return messages;
}

/** 读取原始会话历史；压缩只影响模型上下文，不影响用户查看旧消息。 */
export function readHistory(userId: number, familyId: number, before?: string): HistoryResult {
  const manager = SessionManager.continueRecent(
    appDirectory, path.join(dataDirectory, String(userId), String(familyId)),
  );
  const messages = toChatMessages(manager.getEntries());
  const end = before ? messages.findIndex((message) => message.id === before) : messages.length;
  if (end < 0) throw new Error("历史消息游标不存在");
  const start = Math.max(0, end - 30);
  const page = messages.slice(start, end);
  return { messages: page, next_before: start > 0 ? page[0].id : null };
}

/** 删除当前用户在当前家庭的全部会话文件，下次提问创建全新上下文。 */
export function clearHistory(userId: number, familyId: number): void {
  rmSync(path.join(dataDirectory, String(userId), String(familyId)), { recursive: true, force: true });
  logEvent("chat_history_cleared", { user_id: userId, family_id: familyId });
}

/** 执行一轮问答；工具闭包直接引用本轮快照，不向模型自动注入整份库存。 */
export async function runTurn(
  request: RunTurnRequest, requestId: string, onProgress: (progress: ChatProgress) => void,
): Promise<TurnResult> {
  const startedAt = Date.now();
  logEvent("turn_started", { inventory_count: request.items.length, model: model.id });
  const manager = SessionManager.continueRecent(
    appDirectory, path.join(dataDirectory, String(request.user_id), String(request.family_id)),
  );
  const firstEntry = manager.getEntries().length;
  let completedMessages: ChatMessage[] = [];
  let draft: ChatMessage | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  /** 完成一个模型工具轮次后同步已落盘消息，并以同一快照替换临时草稿。 */
  const publishCompleted = () => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = undefined;
    draft = null;
    completedMessages = toChatMessages(manager.getEntries().slice(firstEntry));
    onProgress({ messages: completedMessages, draft });
  };
  const { items } = request;
  const descriptions = items.map(({ id, name, location_text, record_text }) =>
    ({ id, name, location_text, record_text }));
  const searchSchema = Type.Object({
    keywords: Type.Array(Type.String({ pattern: "\\S" }), { minItems: 1 }),
    location: Type.Optional(Type.String({ pattern: "\\S" })),
  });
  const searchTool: ToolDefinition<typeof searchSchema> = {
    name: "search_items",
    label: "查询物品",
    description: "按关键词查询本轮最新库存。多个关键词任一命中即可，可同时提供近义词、品牌、型号；位置是附加条件。结果不是语义类别的完整统计。",
    parameters: searchSchema,
    async execute(_id, { keywords, location }) {
      const words = keywords.map((word) => word.trim().toLowerCase());
      const matches = descriptions.filter((item) => {
        const text = `${item.name}\n${item.location_text}\n${item.record_text}`.toLowerCase();
        return words.some((word) => text.includes(word)) &&
          (!location || item.location_text.toLowerCase().includes(location.trim().toLowerCase()));
      });
      return { content: [{ type: "text", text: JSON.stringify({ items: matches }) }], details: undefined };
    },
  };
  const allTool: ToolDefinition = {
    name: "read_all_items",
    label: "读取全部物品",
    description: "读取当前家庭本轮全部有效物品的编号、名称、位置和描述。用于多轮查找不理想、整体语义分析，以及数量和完整集合问题。",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify({ items: descriptions }) }], details: undefined };
    },
  };
  const cardsSchema = Type.Object({
    item_ids: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true }),
  });
  const cardsTool: ToolDefinition<typeof cardsSchema> = {
    name: "show_items",
    label: "展示物品",
    description: "在对话当前位置插入物品照片和位置卡片，编号必须来自本轮库存。",
    parameters: cardsSchema,
    async execute(_id, { item_ids }) {
      const selected = item_ids.map((id) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) throw new Error(`当前家庭没有编号为 ${id} 的有效物品`);
        return { id: item.id, name: item.name, location_text: item.location_text, image_url: item.image_url };
      });
      return {
        content: [{ type: "text", text: `已展示物品：${item_ids.join(", ")}` }],
        details: { type: "item_cards", items: selected },
      };
    },
  };

  let runError: string | undefined;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: appDirectory,
    agentDir: dataDirectory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: SYSTEM_PROMPT,
    extensionFactories: [(pi) => {
      // 用户消息此时已落盘，尽早替换页面中的本地发送占位。
      pi.on("before_provider_request", () => publishCompleted());
      // SDK 将工具异常转为工具结果；在此结束本轮，不能把错误伪装成没找到。
      pi.on("tool_result", (event, ctx) => {
        if (event.isError) {
          runError = event.content.filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text).join("\n");
          ctx.abort();
        }
      });
      pi.on("session_before_compact", async (event, ctx) => {
        const compactStartedAt = Date.now();
        logEvent("compaction_started");
        const preparation = event.preparation;
        try {
          const conversation = serializeConversation(convertToLlm([
            ...preparation.messagesToSummarize, ...preparation.turnPrefixMessages,
          ]));
          const response = await modelRuntime.completeSimple(model, {
            systemPrompt: COMPACTION_PROMPT,
            messages: [{
              role: "user",
              content: `已有摘要：\n${preparation.previousSummary || "无"}\n\n对话：\n${conversation}`,
              timestamp: Date.now(),
            }],
          }, { signal: event.signal, maxTokens, maxRetries: 0 });
          if (response.stopReason === "error" || response.stopReason === "aborted" ||
              response.stopReason === "length") {
            throw new Error(response.errorMessage || `摘要生成未完成：${response.stopReason}`);
          }
          const summary = response.content.filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text).join("\n").trim();
          if (!summary) throw new Error("模型返回了空摘要");
          logEvent("compaction_completed", { elapsed_ms: Date.now() - compactStartedAt });
          return { compaction: {
            summary, firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore, usage: response.usage,
          } };
        } catch (error) {
          // Pi 默认会继续压缩；显式取消并终止本轮，让摘要错误到达接口。
          runError = `对话压缩失败：${(error as Error).message}`;
          logEvent("compaction_failed", { error: runError, elapsed_ms: Date.now() - compactStartedAt });
          ctx.abort();
          return { cancel: true };
        }
      });
      pi.on("session_compact_failed", (event, ctx) => {
        runError = `对话压缩失败：${event.errorMessage || "压缩已中止"}`;
        logEvent("compaction_failed", { error: runError });
        ctx.abort();
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: appDirectory, agentDir: dataDirectory, modelRuntime, model,
    thinkingLevel: "off", resourceLoader: loader, sessionManager: manager, settingsManager,
    tools: ["search_items", "read_all_items", "show_items"],
    customTools: [searchTool, allTool, cardsTool],
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!draft) {
        draft = {
          id: `${requestId}:draft`, role: "assistant",
          created_at: new Date().toISOString(), blocks: [{ type: "text", text: "" }],
        };
      }
      const block = draft.blocks[0] as Extract<MessageBlock, { type: "text" }>;
      block.text += event.assistantMessageEvent.delta;
      if (!draftTimer) {
        draftTimer = setTimeout(() => {
          draftTimer = undefined;
          onProgress({ messages: completedMessages, draft });
        }, 200);
      }
    } else if (event.type === "turn_end") {
      // SDK 在 message_end 通知之后才写盘；turn_end 已包含本轮全部工具结果。
      publishCompleted();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      logEvent("model_message_completed", {
        stop_reason: event.message.stopReason,
        input_tokens: event.message.usage.input, output_tokens: event.message.usage.output,
        error: event.message.errorMessage,
      });
    } else if (event.type === "tool_execution_start") {
      logEvent("tool_started", { tool: event.toolName, tool_call_id: event.toolCallId });
    } else if (event.type === "tool_execution_end") {
      logEvent("tool_completed", {
        tool: event.toolName, tool_call_id: event.toolCallId,
        elapsed_ms: event.durationMs, is_error: event.isError,
      });
    }
  });
  try {
    await session.bindExtensions({
      onError(error) {
        runError = `Agent 扩展执行失败：${error.error}`;
        logEvent("extension_failed", { error: runError });
        void session.abort();
      },
    });
    await session.prompt(request.text, { expandPromptTemplates: false });
    if (runError) throw new Error(runError);
    const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
    if (lastAssistant?.role === "assistant" &&
        ["error", "aborted", "length"].includes(lastAssistant.stopReason)) {
      throw new Error(lastAssistant.errorMessage || `模型回答未完成：${lastAssistant.stopReason}`);
    }
    // 最终消息只经由任务结果交付，进度通道不再重复推送。
    const messages = toChatMessages(manager.getEntries().slice(firstEntry));
    logEvent("turn_completed", { elapsed_ms: Date.now() - startedAt, message_count: messages.length });
    return { messages };
  } catch (error) {
    logEvent("turn_failed", {
      elapsed_ms: Date.now() - startedAt,
      error: (error as Error).message, stack: (error as Error).stack,
    }, "ERROR");
    manager.appendCustomEntry("chat_error", { message: (error as Error).message });
    publishCompleted();
    throw error;
  } finally {
    if (draftTimer) clearTimeout(draftTimer);
    unsubscribe();
    session.dispose();
  }
}
