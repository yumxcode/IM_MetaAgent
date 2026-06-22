/**
 * 媒体处理模块
 *
 * 覆盖微信 iLink 的全部媒体能力：
 *  - AES-128-ECB 加解密（PKCS7 padding）
 *  - CDN 上传（getUploadUrl → POST 加密文件 → 拿 download param）
 *  - CDN 下载（encrypt_query_param → GET → 解密）
 *  - MIME 类型映射
 *  - 远程文件下载到本地临时文件
 *  - SILK 语音 → WAV 转码（可选依赖 silk-wasm）
 *  - 统一的本地文件上传管线（按 MIME 路由到 image/video/file）
 *
 * 与官方插件的 CDN + 媒体管线行为对齐。
 */
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

import { CDN_BASE_URL, UploadMediaType, WEIXIN_MEDIA_MAX_BYTES, SILK_SAMPLE_RATE } from "./constants.mjs";
import { getUploadUrl } from "./http.mjs";
import {
  encryptAesEcb,
  decryptAesEcb,
  aesEcbPaddedSize,
} from "./crypto.mjs";
import { getExtensionFromContentTypeOrUrl, getMimeFromFilename } from "./mime.mjs";
import { log, randomAesKey, randomFileKey, tempFileName } from "./util.mjs";

// ---------------------------------------------------------------------------
// CDN URL 构建
// ---------------------------------------------------------------------------

/** 构建 CDN 下载 URL。 */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 构建 CDN 上传 URL。 */
export function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ---------------------------------------------------------------------------
// CDN 上传（带 AES-128-ECB 加密 + 重试）
// ---------------------------------------------------------------------------

const UPLOAD_MAX_RETRIES = 3;

/**
 * 上传一个 buffer 到微信 CDN，返回 CDN 下发的 download encrypted_query_param。
 * 内部完成 AES-128-ECB 加密。服务端错误重试，4xx 客户端错误立即终止。
 *
 * @returns {Promise<string>} downloadParam（用于回填到 media.encrypt_query_param）
 */
export async function uploadBufferToCdn({ buf, uploadParam, filekey, cdnBaseUrl, aeskey, label = "cdn-upload" }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  log.debug(`${label}: CDN POST`, { url: `(cdn)`, ciphertextSize: ciphertext.length });

  let downloadParam;
  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      // 4xx 客户端错误：不可重试
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      // 5xx / 非 200：可重试
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      log.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      // 客户端错误不重试
      if (err.message?.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        log.warn(`${label}: attempt ${attempt} failed, retrying`, { err: String(err) });
      } else {
        log.error(`${label}: all ${UPLOAD_MAX_RETRIES} attempts failed`, { err: String(err) });
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return downloadParam;
}

// ---------------------------------------------------------------------------
// CDN 下载（带 AES-128-ECB 解密）
// ---------------------------------------------------------------------------

/**
 * 解析 CDNMedia.aes_key 字段为原始 16 字节 AES key。
 *
 * 微信 CDN 实际存在两种 aes_key 编码：
 *  - base64(原始 16 字节)            → 图片（media.aes_key）
 *  - base64(16 字节的 hex 字符串)    → 文件 / 语音 / 视频
 * 后者 base64 解码后是 32 个 ASCII hex 字符，需再 hex 解析为 16 字节。
 */
export function parseAesKey(aesKeyBase64, label = "cdn") {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

async function fetchCdnBytes(url, label) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    log.error(`${label}: CDN fetch network error`, { err: String(err) });
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 下载并 AES-128-ECB 解密一个 CDN 媒体文件，返回明文 Buffer。
 *
 * @param {string} encryptedQueryParam - encrypt_query_param
 * @param {string} aesKeyBase64 - CDNMedia.aes_key（base64）
 * @param {string} [cdnBaseUrl]
 * @param {string} [label]
 * @returns {Promise<Buffer>} 明文
 */
export async function downloadAndDecryptBuffer(encryptedQueryParam, aesKeyBase64, cdnBaseUrl = CDN_BASE_URL, label = "cdn-download") {
  const key = parseAesKey(aesKeyBase64, label);
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  log.debug(`${label}: fetching`, { url: `(cdn)` });
  const encrypted = await fetchCdnBytes(url, label);
  log.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
  return decryptAesEcb(encrypted, key);
}

/** 下载 CDN 原始字节（不解密，用于无 aes_key 的场景）。 */
export async function downloadPlainCdnBuffer(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL, label = "cdn-download-plain") {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  log.debug(`${label}: fetching`, { url: `(cdn)` });
  return fetchCdnBytes(url, label);
}

// ---------------------------------------------------------------------------
// 远程 URL → 本地临时文件
// ---------------------------------------------------------------------------

/**
 * 下载远程 http(s) URL 到本地临时文件。
 * 扩展名从 Content-Type 或 URL 推断。
 */
export async function downloadRemoteUrlToTemp(url, destDir) {
  log.debug(`downloadRemoteUrlToTemp: fetching`, { url });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`remote media download failed: ${res.status} ${res.statusText} url=${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });
  const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
  const name = tempFileName("weixin-remote", ext);
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  log.debug(`downloadRemoteUrlToTemp: saved`, { filePath, size: buf.length });
  return filePath;
}

// ---------------------------------------------------------------------------
// 统一上传管线：本地文件 → CDN
// ---------------------------------------------------------------------------

/**
 * 上传后的文件信息，用于构造出站消息的 media 引用。
 */
export class UploadedFileInfo {
  constructor({ filekey, downloadEncryptedQueryParam, aeskey, fileSize, fileSizeCiphertext }) {
    this.filekey = filekey;
    /** 回填到 media.encrypt_query_param */
    this.downloadEncryptedQueryParam = downloadEncryptedQueryParam;
    /** AES-128 key，hex 字符串；构造消息时转 base64 */
    this.aeskey = aeskey;
    /** 明文字节数 */
    this.fileSize = fileSize;
    /** 密文字节数（AES-128-ECB + PKCS7） */
    this.fileSizeCiphertext = fileSizeCiphertext;
  }
}

/**
 * 上传本地文件到微信 CDN 的通用管线。
 *
 * 流程：读取文件 → MD5 → 生成 aeskey → getUploadUrl → uploadBufferToCdn → 返回信息。
 * 缩略图：微信协议要求 IMAGE/VIDEO 提供缩略图，但实测 no_need_thumb:true 可跳过，
 * 与官方插件实现一致。
 */
async function uploadMediaToCdn({ filePath, toUserId, opts, cdnBaseUrl, mediaType, label }) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomFileKey();
  const aeskey = randomAesKey();

  log.debug(`${label}`, { file: filePath, rawsize, filesize, md5: rawfilemd5, filekey });

  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    routeTag: opts.routeTag,
  });

  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload_param: ${JSON.stringify(uploadUrlResp)}`);
  }

  const downloadParam = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[filekey=${filekey}]`,
  });

  return new UploadedFileInfo({
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  });
}

/** 上传图片。 */
export function uploadImage({ filePath, toUserId, opts, cdnBaseUrl = CDN_BASE_URL }) {
  return uploadMediaToCdn({ filePath, toUserId, opts, cdnBaseUrl, mediaType: UploadMediaType.IMAGE, label: "uploadImage" });
}

/** 上传视频。 */
export function uploadVideo({ filePath, toUserId, opts, cdnBaseUrl = CDN_BASE_URL }) {
  return uploadMediaToCdn({ filePath, toUserId, opts, cdnBaseUrl, mediaType: UploadMediaType.VIDEO, label: "uploadVideo" });
}

/** 上传文件附件（非图片/视频）。 */
export function uploadFileAttachment({ filePath, toUserId, opts, cdnBaseUrl = CDN_BASE_URL }) {
  return uploadMediaToCdn({ filePath, toUserId, opts, cdnBaseUrl, mediaType: UploadMediaType.FILE, label: "uploadFileAttachment" });
}

/**
 * 按本地文件扩展名（MIME）路由到对应的上传函数。
 *   video/* → uploadVideo
 *   image/* → uploadImage
 *   else    → uploadFileAttachment
 */
export async function uploadLocalFile({ filePath, toUserId, opts, cdnBaseUrl = CDN_BASE_URL }) {
  const mime = getMimeFromFilename(filePath);
  if (mime.startsWith("video/")) {
    return uploadVideo({ filePath, toUserId, opts, cdnBaseUrl });
  }
  if (mime.startsWith("image/")) {
    return uploadImage({ filePath, toUserId, opts, cdnBaseUrl });
  }
  return uploadFileAttachment({ filePath, toUserId, opts, cdnBaseUrl });
}

/**
 * 上传一个内存 Buffer 到 CDN（例如程序生成的图片/数据文件）。
 * 通过先写入临时文件再走 uploadMediaToCdn，保证 MD5/大小计算与文件上传一致。
 *
 * @param {Buffer} buf
 * @param {object} params
 * @param {string} params.ext - 临时文件扩展名（如 ".png"），影响 MIME 推断
 * @param {string} params.toUserId
 * @param {object} params.opts - { baseUrl, token, routeTag }
 * @param {string} [params.cdnBaseUrl]
 * @param {number} params.mediaType - UploadMediaType 值
 * @returns {Promise<UploadedFileInfo>}
 */
export async function uploadBuffer({ buf, ext = ".bin", toUserId, opts, cdnBaseUrl = CDN_BASE_URL, mediaType }) {
  const tmpDir = path.join(os.tmpdir(), "weixin-bot-upload");
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, tempFileName("weixin-buf", ext));
  await fs.writeFile(filePath, buf);
  try {
    return await uploadMediaToCdn({
      filePath,
      toUserId,
      opts,
      cdnBaseUrl,
      mediaType,
      label: `uploadBuffer[type=${mediaType}]`,
    });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// SILK → WAV 转码（语音消息）
// ---------------------------------------------------------------------------

/**
 * 将 PCM s16le 字节包装成 WAV 容器（单声道，16 位）。
 */
function pcmBytesToWav(pcm, sampleRate) {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;

  buf.write("RIFF", offset); offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4;
  buf.write("WAVE", offset); offset += 4;
  buf.write("fmt ", offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4;
  buf.writeUInt16LE(1, offset); offset += 4; // PCM
  buf.writeUInt16LE(1, offset); offset += 2; // mono
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset); offset += 4; // byte rate
  buf.writeUInt16LE(2, offset); offset += 2; // block align
  buf.writeUInt16LE(16, offset); offset += 2; // bits per sample
  buf.write("data", offset); offset += 4;
  buf.writeUInt32LE(pcmBytes, offset); offset += 4;

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);
  return buf;
}

/**
 * 尝试用 silk-wasm 解码 SILK 音频为 WAV。
 * silk-wasm 是可选依赖：未安装或解码失败时返回 null，调用方应回退到原始 SILK。
 *
 * @returns {Promise<Buffer|null>} WAV Buffer 或 null
 */
export async function silkToWav(silkBuf) {
  try {
    const { decode } = await import("silk-wasm");
    log.debug(`silkToWav: decoding ${silkBuf.length} bytes of SILK`);
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    log.debug(`silkToWav: decoded`, { durationMs: result.duration, pcmBytes: result.data.byteLength });
    return pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
  } catch (err) {
    log.warn(`silkToWav: transcode failed, will use raw silk`, { err: String(err) });
    return null;
  }
}

// 保存到本地（供入站媒体持久化）
/**
 * 将 buffer 保存到指定目录，返回完整路径。
 * 用于入站媒体下载后的持久化（应用层决定目录）。
 */
export async function saveBufferToFile(buf, destDir, { ext = ".bin", prefix = "weixin-media", contentType, originalFilename } = {}) {
  await fs.mkdir(destDir, { recursive: true });
  let name;
  if (originalFilename) {
    name = `${prefix}-${Date.now()}-${originalFilename}`;
  } else {
    name = tempFileName(prefix, ext);
  }
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  return filePath;
}

export { WEIXIN_MEDIA_MAX_BYTES };
