/** 任务状态轮询：长耗时接口返回 task_id，循环拉取阶段直至完成（文档：轮询而非 SSE/WS）。 */
const { ApiError, request } = require("./api");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// options: { intervalMs?, timeoutMs?, isCancelled?, onTask?, onStage?, onProgress?, initialStatus? }
/** 串行轮询任务，版本变化时先交付进度，再处理完成或失败。 */
async function pollTask(taskId, options = {}) {
  const interval = options.intervalMs ?? 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 120000);
  let lastKey = "";
  let lastRevision = -1;
  let initialStatus = options.initialStatus;
  for (;;) {
    if (options.isCancelled && options.isCancelled()) {
      throw new ApiError({ code: "CANCELLED", message: "已取消", retryable: false });
    }
    const status = initialStatus || await request({
      path: `/tasks/${taskId}`,
      onTask: options.onTask,
      isCancelled: options.isCancelled,
    });
    initialStatus = null;
    const key = `${status.stage}:${status.detail}`;
    if (key !== lastKey) {
      lastKey = key;
      if (options.onStage) options.onStage(status.stage, status.detail);
    }
    if (status.revision !== lastRevision) {
      lastRevision = status.revision;
      if (status.progress && options.onProgress) options.onProgress(status.progress);
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
