/** 任务状态轮询：长耗时接口返回 task_id，循环拉取阶段直至完成（文档：轮询而非 SSE/WS）。 */
import { ApiError, request } from "./api";

export interface TaskErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TaskStatus {
  task_id: string;
  kind: string;
  stage: string;
  detail: string;
  done: boolean;
  result: unknown;
  error: TaskErrorBody | null;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  isCancelled?: () => boolean;
  onTask?: (task: WechatMiniprogram.RequestTask) => void;
  onStage?: (stage: string, detail: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pollTask<T>(taskId: string, options: PollOptions = {}): Promise<T> {
  const interval = options.intervalMs ?? 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 120000);
  let lastKey = "";
  for (;;) {
    if (options.isCancelled && options.isCancelled()) {
      throw new ApiError({ code: "CANCELLED", message: "已取消", retryable: false });
    }
    const status = await request<TaskStatus>({
      path: `/tasks/${taskId}`,
      onTask: options.onTask,
      isCancelled: options.isCancelled,
    });
    const key = `${status.stage}:${status.detail}`;
    if (key !== lastKey) {
      lastKey = key;
      if (options.onStage) options.onStage(status.stage, status.detail);
    }
    if (status.done) {
      if (status.error) throw new ApiError(status.error);
      return status.result as T;
    }
    if (Date.now() > deadline) {
      throw new ApiError({ code: "TIMEOUT", message: "处理超时，请重试", retryable: true });
    }
    await sleep(interval);
  }
}
