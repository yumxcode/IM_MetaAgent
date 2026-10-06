/** 微信 iLink CDN 媒体上传、下载与 AES-128-ECB 加解密。 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CDN_BASE_URL, UploadMediaType, WEIXIN_MEDIA_MAX_BYTES, SILK_SAMPLE_RATE } from "./constants.mjs";
import { getUploadUrl } from "./http.mjs";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "./crypto.mjs";
import { getExtensionFromContentTypeOrUrl, getMimeFromFilename } from "./mime.mjs";
import { log, randomAesKey, randomFileKey, tempFileName } from "./util.mjs";

const MEDIA_TIMEOUT_MS = 60_000;
const UPLOAD_MAX_RETRIES = 3;

function httpUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("media URL is missing");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("media URL is invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("media URL must use HTTP or HTTPS without credentials");
  }
  return value; // Preserve signed URLs byte-for-byte; never append query parameters.
}

function byteLimit(maxBytes = WEIXIN_MEDIA_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid media byte limit");
  return Math.min(maxBytes, WEIXIN_MEDIA_MAX_BYTES);
}

function assertSize(size, limit, label = "media") {
  if (size > limit) throw new Error(`${label}: media exceeds ${limit} byte limit`);
}

function requestScope({ timeoutMs = MEDIA_TIMEOUT_MS, signal } = {}, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid media timeout");
  const controller = new AbortController();
  let rejectAbort;
  let failure;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // The caller may start with an already-aborted signal.
  aborted.catch(() => {});
  const abort = (kind) => {
    if (failure) return;
    failure = new Error(`${label}: ${kind}`);
    failure.code = kind === "request cancelled" ? "MEDIA_CANCELLED" : "MEDIA_TIMEOUT";
    controller.abort();
    rejectAbort(failure);
  };
  const onAbort = () => abort("request cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort(`timeout after ${timeoutMs}ms`), timeoutMs);
  if (signal?.aborted) onAbort();
  return {
    signal: controller.signal,
    race(action) {
      if (failure) return Promise.reject(failure);
      return Promise.race([Promise.resolve().then(action), aborted]);
    },
    error() { return failure; },
    close() { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); },
  };
}

function cancelBody(res) { void res?.body?.cancel?.().catch(() => {}); }

/** Build the legacy CDN URL from its base and encrypted query parameter. */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL) {
  if (typeof encryptedQueryParam !== "string" || !encryptedQueryParam) throw new Error("CDN download parameter is missing");
  httpUrl(cdnBaseUrl);
  return `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl({ cdnBaseUrl = CDN_BASE_URL, uploadParam, uploadFullUrl, filekey }) {
  if (uploadFullUrl) return httpUrl(uploadFullUrl);
  httpUrl(cdnBaseUrl);
  if (!uploadParam || !filekey) throw new Error("CDN upload parameters are missing");
  return `${cdnBaseUrl.replace(/\/+$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/** Upload encrypted media, accepting either the new upload_full_url or legacy upload_param. */
export async function uploadBufferToCdn({ buf, uploadParam, uploadFullUrl, upload_full_url, filekey,
  cdnBaseUrl = CDN_BASE_URL, aeskey, label = "cdn-upload", timeoutMs, signal, maxBytes }) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new Error("media buffer must be bytes");
  const limit = byteLimit(maxBytes);
  assertSize(buf.byteLength, limit, label);
  const ciphertext = encryptAesEcb(buf, aeskey);
  assertSize(ciphertext.length, aesEcbPaddedSize(limit), label);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, uploadFullUrl: uploadFullUrl ?? upload_full_url, filekey });
  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    const scope = requestScope({ timeoutMs, signal }, label);
    let res;
    try {
      res = await scope.race(() => fetch(cdnUrl, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext), signal: scope.signal,
      }));
      if (res.status >= 400 && res.status < 500) {
        const err = new Error(`${label}: CDN upload client error ${res.status}`);
        err.code = "MEDIA_CLIENT_ERROR";
        throw err;
      }
      if (res.status !== 200) throw new Error(`${label}: CDN upload server status ${res.status}`);
      const downloadParam = res.headers.get("x-encrypted-param");
      if (typeof downloadParam !== "string" || !downloadParam.trim()) {
        throw new Error(`${label}: CDN upload response missing x-encrypted-param header`);
      }
      log.debug(`${label}: CDN upload success attempt=${attempt}`);
      return downloadParam;
    } catch (err) {
      // Never surface fetch causes, response bodies, signed URLs or AES keys.
      lastError = scope.error() ?? (err?.code === "MEDIA_CLIENT_ERROR" ? err : new Error(
        `${label}: CDN upload failed${res ? ` (status ${res.status}, invalid response)` : " (network error)"}`));
      if (["MEDIA_CLIENT_ERROR", "MEDIA_CANCELLED", "MEDIA_TIMEOUT"].includes(lastError.code)) throw lastError;
      if (attempt < UPLOAD_MAX_RETRIES) log.warn(`${label}: CDN upload attempt ${attempt} failed, retrying`);
    } finally { cancelBody(res); scope.close(); }
  }
  throw lastError;
}

/** CDN aes_key accepts base64(raw 16 bytes) and base64(32 ASCII hex characters). */
export function parseAesKey(aesKeyBase64, label = "cdn") {
  if (typeof aesKeyBase64 !== "string" || aesKeyBase64.length > 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(aesKeyBase64)
      || aesKeyBase64.length % 4 === 1) throw new Error(`${label}: invalid base64 aes_key`);
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== aesKeyBase64.replace(/=+$/, "")) {
    throw new Error(`${label}: invalid base64 aes_key`);
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("latin1"))) {
    return Buffer.from(decoded.toString("latin1"), "hex");
  }
  throw new Error(`${label}: aes_key must decode to 16 raw bytes or 32 ASCII hex characters`);
}

async function readResponseBytes(res, scope, maxBytes, label) {
  const declaredLength = res.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) assertSize(Number(declaredLength), maxBytes, label);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await scope.race(() => reader.read());
      if (done) { finished = true; break; }
      size += value.byteLength;
      assertSize(size, maxBytes, label);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* pending abort read */ }
  }
}

async function fetchMediaBytes(url, options, label, maxBytes) {
  httpUrl(url);
  const scope = requestScope(options, label);
  let res;
  try {
    res = await scope.race(() => fetch(url, { signal: scope.signal }));
    if (!res.ok) throw new Error(`${label}: CDN download HTTP ${res.status}`);
    const buf = await readResponseBytes(res, scope, maxBytes, label);
    return { buf, contentType: res.headers.get("content-type") };
  } catch (err) {
    if (scope.error()) throw scope.error();
    if (err?.message?.startsWith(`${label}: media exceeds`) || err?.message?.startsWith(`${label}: CDN download HTTP`)) throw err;
    throw new Error(`${label}: media download failed (network or response error)`);
  } finally { cancelBody(res); scope.close(); }
}

function mediaDownloadUrl(media, cdnBaseUrl) {
  return media.full_url ? httpUrl(media.full_url) : buildCdnDownloadUrl(
    media.encrypt_query_param ?? media.encrypted_query_param, cdnBaseUrl);
}

/** New form: downloadAndDecryptBuffer(CDNMedia, {cdnBaseUrl, label, timeoutMs, signal, maxBytes}).
 * Legacy positional form remains supported: (query, aesKeyBase64, cdnBaseUrl, label).
 */
export async function downloadAndDecryptBuffer(mediaOrParam, keyOrOptions, cdnBaseUrl = CDN_BASE_URL, label = "cdn-download") {
  const modern = mediaOrParam && typeof mediaOrParam === "object";
  const media = modern ? mediaOrParam : { encrypt_query_param: mediaOrParam, aes_key: keyOrOptions };
  const options = modern ? (keyOrOptions ?? {}) : {};
  label = options.label ?? label;
  const limit = byteLimit(options.maxBytes);
  const key = parseAesKey(media.aes_key, label);
  const { buf } = await fetchMediaBytes(mediaDownloadUrl(media, options.cdnBaseUrl ?? cdnBaseUrl), options, label, aesEcbPaddedSize(limit));
  let plaintext;
  try { plaintext = decryptAesEcb(buf, key); } catch { throw new Error(`${label}: invalid encrypted media`); }
  assertSize(plaintext.length, limit, label);
  return plaintext;
}

/** New form: downloadPlainCdnBuffer(CDNMedia, options); legacy (query, cdnBaseUrl, label). */
export async function downloadPlainCdnBuffer(mediaOrParam, baseOrOptions = CDN_BASE_URL, label = "cdn-download-plain") {
  const modern = mediaOrParam && typeof mediaOrParam === "object";
  const media = modern ? mediaOrParam : { encrypt_query_param: mediaOrParam };
  const options = modern && typeof baseOrOptions === "object" ? baseOrOptions : {};
  label = options.label ?? label;
  const cdnBaseUrl = options.cdnBaseUrl ?? (typeof baseOrOptions === "string" ? baseOrOptions : CDN_BASE_URL);
  return (await fetchMediaBytes(mediaDownloadUrl(media, cdnBaseUrl), options, label, byteLimit(options.maxBytes))).buf;
}

/** Download bounded remote HTTP(S) media and leave no partial temporary file on failure. */
export async function downloadRemoteUrlToTemp(url, destDir, options = {}) {
  const { buf, contentType } = await fetchMediaBytes(url, options, "remote-media", byteLimit(options.maxBytes));
  const ext = getExtensionFromContentTypeOrUrl(contentType, url);
  return saveBufferToFile(buf, destDir, { ext, prefix: "weixin-remote" });
}

export class UploadedFileInfo {
  constructor({ filekey, downloadEncryptedQueryParam, aeskey, fileSize, fileSizeCiphertext }) {
    Object.assign(this, { filekey, downloadEncryptedQueryParam, aeskey, fileSize, fileSizeCiphertext });
  }
}

/** Read a regular file after checking its stat; bound reads even if the file grows during upload. */
async function readLocalMedia(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("media upload requires a regular file");
    assertSize(stat.size, maxBytes);
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      assertSize(size, maxBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

export function isSilkBuffer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  return buf.subarray(0, 9).toString("latin1") === "#!SILK_V3"
    || (buf[0] === 2 && buf.subarray(1, 10).toString("latin1") === "#!SILK_V3");
}

async function uploadMediaBuffer({ plaintext, toUserId, opts = {}, cdnBaseUrl, mediaType, label, maxBytes }) {
  const limit = byteLimit(maxBytes ?? opts.maxBytes);
  assertSize(plaintext.length, limit, label);
  if (mediaType === UploadMediaType.VOICE && !isSilkBuffer(plaintext)) {
    throw new Error(`${label}: voice upload requires SILK V3 encoded audio`);
  }
  const rawsize = plaintext.length;
  const filesize = aesEcbPaddedSize(rawsize);
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filekey = randomFileKey();
  const aeskey = randomAesKey();
  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl, token: opts.token, routeTag: opts.routeTag, timeoutMs: opts.timeoutMs,
    signal: opts.signal ?? opts.abortSignal, filekey, media_type: mediaType, to_user_id: toUserId,
    rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskey.toString("hex"),
  });
  if (!uploadUrlResp.upload_full_url && !uploadUrlResp.upload_param) {
    throw new Error(`${label}: getUploadUrl returned no upload_full_url or upload_param`);
  }
  const downloadParam = await uploadBufferToCdn({
    buf: plaintext, uploadParam: uploadUrlResp.upload_param,
    uploadFullUrl: uploadUrlResp.upload_full_url, filekey, cdnBaseUrl, aeskey, label,
    timeoutMs: opts.timeoutMs, signal: opts.signal ?? opts.abortSignal, maxBytes: limit,
  });
  return new UploadedFileInfo({ filekey, downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"), fileSize: rawsize, fileSizeCiphertext: filesize });
}

async function uploadMediaToCdn(params) {
  const plaintext = await readLocalMedia(params.filePath, byteLimit(params.maxBytes ?? params.opts?.maxBytes));
  return uploadMediaBuffer({ ...params, plaintext });
}

export function uploadImage(params) {
  return uploadMediaToCdn({ cdnBaseUrl: CDN_BASE_URL, ...params, mediaType: UploadMediaType.IMAGE, label: "uploadImage" });
}
export function uploadVideo(params) {
  return uploadMediaToCdn({ cdnBaseUrl: CDN_BASE_URL, ...params, mediaType: UploadMediaType.VIDEO, label: "uploadVideo" });
}
export function uploadFileAttachment(params) {
  return uploadMediaToCdn({ cdnBaseUrl: CDN_BASE_URL, ...params, mediaType: UploadMediaType.FILE, label: "uploadFileAttachment" });
}
export function uploadVoice(params) {
  return uploadMediaToCdn({ cdnBaseUrl: CDN_BASE_URL, ...params, mediaType: UploadMediaType.VOICE, label: "uploadVoice" });
}

export async function uploadLocalFile(params) {
  const mime = params.mimeType ?? getMimeFromFilename(params.filePath);
  if (mime.startsWith("video/")) return uploadVideo(params);
  if (mime.startsWith("image/")) return uploadImage(params);
  if (mime === "audio/silk" || /\.silk$/i.test(params.filePath)) return uploadVoice(params);
  return uploadFileAttachment(params);
}

/** Upload bytes directly, without writing a temporary file. */
export async function uploadBuffer({ buf, toUserId, opts, cdnBaseUrl = CDN_BASE_URL, mediaType, maxBytes }) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new Error("media buffer must be bytes");
  assertSize(buf.byteLength, byteLimit(maxBytes ?? opts?.maxBytes));
  return uploadMediaBuffer({ plaintext: Buffer.from(buf), toUserId, opts, cdnBaseUrl, mediaType, maxBytes, label: "uploadBuffer" });
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
    log.warn(`silkToWav: transcode failed, will use raw silk`);
    return null;
  }
}

/** Save incoming media under a safe, unique filename, stripping any supplied path components. */
export async function saveBufferToFile(buf, destDir, { ext = ".bin", prefix = "weixin-media", originalFilename } = {}) {
  assertSize(buf.byteLength, WEIXIN_MEDIA_MAX_BYTES);
  await fs.mkdir(destDir, { recursive: true });
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "weixin-media";
  const safeExt = /^\.[a-zA-Z0-9]{1,16}$/.test(ext) ? ext : ".bin";
  let safeOriginal = typeof originalFilename === "string"
    ? originalFilename.replace(/\\/g, "/").split("/").pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").trim().slice(0, 128)
    : "";
  if (!safeOriginal || /^\.+$/.test(safeOriginal)) safeOriginal = "";
  const name = safeOriginal ? `${tempFileName(safePrefix, "")}-${safeOriginal}` : tempFileName(safePrefix, safeExt);
  const filePath = path.join(destDir, name);
  try { await fs.writeFile(filePath, buf, { flag: "wx", mode: 0o600 }); }
  catch (err) {
    // wx prevents modifying an existing file. Clean up a newly-created partial write.
    if (err.code !== "EEXIST") await fs.unlink(filePath).catch(() => {});
    throw err;
  }
  return filePath;
}

export { WEIXIN_MEDIA_MAX_BYTES };
