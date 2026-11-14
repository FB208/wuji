/** 图片压缩与上传：长边压缩至不超过 1600px 后上传（文档 10.5）。 */
import { ApiError, request, uploadFile } from "./api";
import { pollTask } from "./tasks";

const MAX_EDGE = 1600;

export interface ImageUploadResult {
  image_url: string;
  image_token: string;
}

interface UploadExtras {
  onTask?: (task: WechatMiniprogram.UploadTask) => void;
  isCancelled?: () => boolean;
  onProgress?: (percent: number) => void;
  onStage?: (stage: string, detail: string) => void;
  timeout?: number;
}

async function compressIfNeeded(filePath: string): Promise<string> {
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

export async function uploadImage(
  familyId: number,
  filePath: string,
  options: UploadExtras = {}
): Promise<ImageUploadResult> {
  const compressed = await compressIfNeeded(filePath);
  if (options.isCancelled && options.isCancelled()) {
    throw new ApiError({ code: "CANCELLED", message: "已取消", retryable: false });
  }
  return uploadFile<ImageUploadResult>({
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

export interface TranscribeResult {
  transcript: string;
}

interface TaskRef {
  task_id: string;
}

export async function transcribeAudio(
  filePath: string,
  options: UploadExtras = {}
): Promise<TranscribeResult> {
  // 第一阶段：音频上传（有真实进度）；返回 task_id 后进入第二阶段轮询
  const ref = await uploadFile<TaskRef>({
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
  return pollTask<TranscribeResult>(ref.task_id, {
    isCancelled: options.isCancelled,
    onStage: options.onStage,
    timeoutMs: 90000,
  });
}

export interface RecordResult {
  operation: string;
  item: {
    id: number;
    name: string;
    location_text: string;
    record_text: string;
    image_url: string;
    version: number;
    updated_at: string | null;
  };
}

export async function recordItem(
  familyId: number,
  imageToken: string,
  transcript: string,
  idempotencyKey: string,
  options: UploadExtras = {}
): Promise<RecordResult> {
  const ref = await request<TaskRef>({
    path: "/items/record",
    method: "POST",
    data: { family_id: familyId, image_token: imageToken, transcript },
    idempotencyKey,
    isCancelled: options.isCancelled,
    timeout: options.timeout,
  });
  return pollTask<RecordResult>(ref.task_id, {
    isCancelled: options.isCancelled,
    onStage: options.onStage,
    timeoutMs: 60000,
  });
}
