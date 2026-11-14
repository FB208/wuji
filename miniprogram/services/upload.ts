/** 图片压缩与上传：长边压缩至不超过 1600px 后上传（文档 10.5）。 */
import { ApiError, uploadFile } from "./api";

const MAX_EDGE = 1600;

export interface ImageUploadResult {
  image_url: string;
  image_token: string;
}

interface UploadExtras {
  onTask?: (task: WechatMiniprogram.UploadTask) => void;
  isCancelled?: () => boolean;
  onProgress?: (percent: number) => void;
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

export function transcribeAudio(
  filePath: string,
  options: UploadExtras = {}
): Promise<TranscribeResult> {
  return uploadFile<TranscribeResult>({
    path: "/speech/transcribe",
    filePath,
    name: "audio",
    onTask: options.onTask,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    timeout: options.timeout,
  });
}
