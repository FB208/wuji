/** 任务状态轮询：长耗时接口返回 task_id，循环拉取阶段直至完成（文档：轮询而非 SSE/WS）。 */
const { ApiError, request } = require("./api");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// options: { intervalMs?, timeoutMs?, isCancelled?, onTask?, onStage? }
async function pollTask(taskId, options = {}) {
  const interval = options.intervalMs ?? 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 120000);
  let lastKey = "";
  for (;;) {
    if (options.isCancelled && options.isCancelled()) {
      throw new ApiError({ code: "CANCELLED", message: "已取消", retryable: false });
    }
    const status = await request({
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
      return status.result;
    }
    if (Date.now() > deadline) {
      throw new ApiError({ code: "TIMEOUT", message: "处理超时，请重试", retryable: true });
    }
    await sleep(interval);
  }
}

module.exports = { pollTask };
