import { Console } from "node:console";
import { createInterface } from "node:readline";
import type { ChatProgress, HistoryResult, RunTurnRequest, TurnResult } from "./types.js";
import { logEvent, traceContext } from "./logging.js";

// stdout 专用于管道协议；stderr 由 Python 接收并写入统一日志。
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const { readHistory, clearHistory, runTurn } = await import("./chat.js");

type WorkerRequest =
  | { id: string; method: "turn"; params: RunTurnRequest }
  | { id: string; method: "history" | "clear"; params: {
      user_id: number; family_id: number; before?: string;
    } };

type WorkerResponse =
  | { type: "ready" }
  | { type: "progress"; id: string; progress: ChatProgress }
  | { type: "response"; id: string; result: HistoryResult | TurnResult | null }
  | { type: "response"; id: string; error: { code: string; message: string } };

/** 每条响应占一行，JSON 中的换行和中文由序列化与 UTF-8 编码处理。 */
function send(response: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** 处理后端已校验的请求；通过编号关联响应，长对话不会阻塞其他家庭读取历史。 */
async function handleRequest(request: WorkerRequest): Promise<void> {
  const startedAt = Date.now();
  logEvent("worker_request_received", {
    method: request.method, user_id: request.params.user_id, family_id: request.params.family_id,
  });
  try {
    let result: HistoryResult | TurnResult | null = null;
    if (request.method === "turn") {
      result = await runTurn(request.params, request.id, (progress) => {
        send({ type: "progress", id: request.id, progress });
      });
    } else if (request.method === "history") {
      result = readHistory(request.params.user_id, request.params.family_id, request.params.before);
    } else {
      clearHistory(request.params.user_id, request.params.family_id);
    }
    send({ type: "response", id: request.id, result });
    logEvent("worker_response_queued", { elapsed_ms: Date.now() - startedAt });
  } catch (error) {
    logEvent("worker_request_failed", {
      elapsed_ms: Date.now() - startedAt,
      error: (error as Error).message, stack: (error as Error).stack,
    }, "ERROR");
    send({
      type: "response", id: request.id,
      error: { code: "AGENT_ERROR", message: (error as Error).message },
    });
  }
}

const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
input.on("line", (line) => {
  const request = JSON.parse(line) as WorkerRequest;
  void traceContext.run({ request_id: request.id }, () => handleRequest(request));
});
// 父进程关闭管道后立即退出，避免后端退出后仍留下 Agent 进程。
input.on("close", () => process.exit(0));
send({ type: "ready" });
logEvent("worker_ready", { pid: process.pid });
