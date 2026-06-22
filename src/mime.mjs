/**
 * MIME 类型映射工具。
 *
 * 用于：
 *  - 根据本地文件扩展名决定上传到 CDN 的 media_type（image/video/file）
 *  - 根据远程响应 Content-Type / URL 推断临时文件扩展名
 *  - 为入站文件附件推断 MIME（微信协议不直接返回 MIME）
 *
 * 与官方插件的 mime 映射保持一致。
 */
import path from "node:path";

const EXTENSION_TO_MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const MIME_TO_EXTENSION = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

/** 根据文件名扩展名获取 MIME，未知返回 application/octet-stream。 */
export function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

/** 根据 MIME 获取扩展名，未知返回 .bin。 */
export function getExtensionFromMime(mimeType) {
  const ct = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[ct] ?? ".bin";
}

/** 根据 Content-Type 或 URL 推断扩展名，未知返回 .bin。 */
export function getExtensionFromContentTypeOrUrl(contentType, url) {
  if (contentType) {
    const ext = getExtensionFromMime(contentType);
    if (ext !== ".bin") return ext;
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const knownExts = new Set(Object.keys(EXTENSION_TO_MIME));
    return knownExts.has(ext) ? ext : ".bin";
  } catch {
    return ".bin";
  }
}
