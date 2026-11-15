/** 图片压缩与上传：长边压缩至不超过 1600px 后上传（文档 10.5）。 */
const { ApiError, request, uploadFile } = require("./api");
const { pollTask } = require("./tasks");

const MAX_EDGE = 1600;

// options: { onTask?, isCancelled?, onProgress?, onStage?, timeout? }
async function compressIfNeeded(filePath) {
  try {
    const info = await wx.getImageInfo({ src: filePath });
    const localPath = info.path || filePath;
    if (Math.max(info.width, info.height) <= MAX_EDGE) return localPath;
    const scale = MAX_EDGE / Math.max(info.width, info.height);
    const res = await wx.compressImage({
      src: localPath,
      compressedWidth: Math.round(info.width * scale),
      compressedHeight: Math.round(info.height * scale),
      quality: 85,
    });
    return res.tempFilePath;
  } catch (_) {
    // 压缩失败时用原图上传，由后端做大小校验
    return filePath;
  }
}

async function uploadImage(familyId, filePath, options = {}) {
  const compressed = await compressIfNeeded(filePath);
  if (options.isCancelled && options.isCancelled()) {
    throw new ApiError({ code: "CANCELLED", message: "已取消", retryable: false });
  }
  return uploadFile({
    path: "/media/images",
    filePath: compressed,
    name: "image",
    formData: { family_id: familyId },
    onTask: options.onTask,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    timeout: options.timeout,
  });
}

async function transcribeAudio(filePath, options = {}) {
  // 第一阶段：音频上传（有真实进度）；返回 task_id 后进入第二阶段轮询
  const ref = await uploadFile({
    path: "/speech/transcribe",
    filePath,
    name: "audio",
    onTask: options.onTask,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    timeout: options.timeout,
  });
  // 第二阶段：后端 RustFS 临时对象 → 火山提交 → 轮询识别结果，经 onStage 透出阶段
  if (options.onStage) options.onStage("asr_start", "");
  return pollTask(ref.task_id, {
    isCancelled: options.isCancelled,
    onStage: options.onStage,
    timeoutMs: 90000,
  });
}

async function recordItem(familyId, imageToken, transcript, idempotencyKey, options = {}) {
  const ref = await request({
    path: "/items/record",
    method: "POST",
    data: { family_id: familyId, image_token: imageToken, transcript },
    idempotencyKey,
    isCancelled: options.isCancelled,
    timeout: options.timeout,
  });
  return pollTask(ref.task_id, {
    isCancelled: options.isCancelled,
    onStage: options.onStage,
    timeoutMs: 60000,
  });
}

// 入库确认：LLM 返回 confirm 后，携带 record_token 与用户选择再次调用（不再判语义）
async function resolveRecord(familyId, recordToken, resolution, idempotencyKey, options = {}) {
  const ref = await request({
    path: "/items/record",
    method: "POST",
    data: { family_id: familyId, record_token: recordToken, resolution },
    idempotencyKey,
    isCancelled: options.isCancelled,
    timeout: options.timeout,
  });
  return pollTask(ref.task_id, {
    isCancelled: options.isCancelled,
    onStage: options.onStage,
    timeoutMs: 60000,
  });
}

module.exports = { uploadImage, transcribeAudio, recordItem, resolveRecord };
