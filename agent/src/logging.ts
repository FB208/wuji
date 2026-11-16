import { AsyncLocalStorage } from "node:async_hooks";

export const traceContext = new AsyncLocalStorage<{ request_id: string }>();

/** 输出单行阶段日志，由 Python 汇入统一日志文件；不输出请求正文或认证头。 */
export function logEvent(
  event: string, fields: Record<string, unknown> = {}, level: "INFO" | "ERROR" = "INFO",
): void {
  process.stderr.write(`[${level}] ${JSON.stringify({
    time: new Date().toISOString(), event, ...traceContext.getStore(), ...fields,
  })}\n`);
}
