/** 图片压缩与上传：长边压缩至不超过 1600px 后上传（文档 10.5）。 */
import { uploadFile } from "./api";

const MAX_EDGE = 1600;

export interface ImageUploadResult {
  image_url: string;
  image_token: string;
}

async function compressIfNeeded(filePath: string): Promise<string> {
  try {
    const info = await wx.getImageInfo({ src: filePath });
    if (Math.max(info.width, info.height) <= MAX_EDGE) return filePath;
    const scale = MAX_EDGE / Math.max(info.width, info.height);
    const res = await wx.compressImage({
      src: filePath,
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

export async function uploadImage(familyId: number, filePath: string): Promise<ImageUploadResult> {
  const compressed = await compressIfNeeded(filePath);
  return uploadFile<ImageUploadResult>({
    path: "/media/images",
    filePath: compressed,
    name: "image",
    formData: { family_id: familyId },
  });
}

export interface TranscribeResult {
  transcript: string;
}

export function transcribeAudio(filePath: string): Promise<TranscribeResult> {
  return uploadFile<TranscribeResult>({
    path: "/speech/transcribe",
    filePath,
    name: "audio",
  });
}
