/**
 * 接入层通用工具：日志、脱敏、ID 生成、文件路径解析
 *
 * 全部为纯函数，无副作用，不依赖任何外部框架。
 */
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const LOG_LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const ENV_LEVEL = (process.env.WEIXIN_LOG_LEVEL || "").toLowerCase();

/**
 * 简易分级日志。默认 info，可通过环境变量 WEIXIN_LOG_LEVEL 调整。
 * 输出到 stderr，避免污染 stdout（stdout 留给 QR 渲染等用户可见输出）。
 */
export const log = {
  _level: LOG_LEVELS[ENV_LEVEL] ?? LOG_LEVELS.info,
  setLevel(level) {
    const l = LOG_LEVELS[String(level).toLowerCase()];
    if (l === undefined) throw new Error(`invalid log level: ${level}`);
    this._level = l;
  },
  _emit(level, msg, meta) {
    if (LOG_LEVELS[level] < this._level) return;
    const ts = new Date().toISOString();
    const line = meta ? `${ts} [${level}] ${msg} ${safeJson(meta)}` : `${ts} [${level}] ${msg}`;
    process.stderr.write(line + "\n");
  },
  trace(msg, meta) { this._emit("trace", msg, meta); },
  debug(msg, meta) { this._emit("debug", msg, meta); },
  info(msg, meta) { this._emit("info", msg, meta); },
  warn(msg, meta) { this._emit("warn", msg, meta); },
  error(msg, meta) { this._emit("error", msg, meta); },
};

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

// ---------------------------------------------------------------------------
// 脱敏：用于日志中避免泄露 token / 完整 body / URL 签名
// ---------------------------------------------------------------------------

export function truncate(s, max = 200) {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(len=${s.length})`;
}

export function redactToken(token, prefixLen = 6) {
  if (!token) return "(none)";
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

export function redactBody(body, maxLen = 200) {
  if (!body) return "(empty)";
  if (body.length <= maxLen) return body;
  return `${body.slice(0, maxLen)}…(truncated, totalLen=${body.length})`;
}

export function redactUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?<redacted>` : base;
  } catch {
    return truncate(rawUrl, 80);
  }
}

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

/**
 * 生成带前缀的唯一 ID：{prefix}:{timestamp}-{8-char hex}
 * 用于 client_id（每条出站消息的唯一标识，幂等去重）。
 */
export function generateId(prefix) {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 生成临时文件名：{prefix}-{timestamp}-{8-char hex}{ext}
 */
export function tempFileName(prefix, ext) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

/**
 * 生成随机 AES-128 key（16 字节 Buffer）。
 */
export function randomAesKey() {
  return crypto.randomBytes(16);
}

/**
 * 生成随机 filekey（16 字节 hex 字符串）。
 */
export function randomFileKey() {
  return crypto.randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64（每次请求都变，防重放）
// ---------------------------------------------------------------------------

export function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// 文件系统：state 目录、JSON 读写
// ---------------------------------------------------------------------------

/**
 * 解析状态目录。
 * 优先级：WEIXIN_STATE_DIR > OPENCLAW_STATE_DIR(兼容) > ~/.weixin-bot
 */
export function resolveStateDir() {
  return (
    process.env.WEIXIN_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() || // 向后兼容
    path.join(os.homedir(), ".weixin-bot")
  );
}

/** 确保目录存在。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 同步读取并解析 JSON 文件，失败返回 fallback。 */
export function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

/**
 * 原子化写入 JSON 文件（先写临时文件再 rename，避免半写状态）。
 * 对含敏感信息的文件设置 0600 权限。
 */
export function writeJson(filePath, data, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(tmp, mode); } catch { /* best-effort */ }
  fs.renameSync(tmp, filePath);
}

/** 删除文件，不存在时静默忽略。 */
export function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** sleep，可被 AbortSignal 中断。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

/** 规范化 URL，确保以 / 结尾，便于 new URL(endpoint, base) 拼接。 */
export function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * 将微信账号 ID（如 "b0f5860fdecb@im.bot"）规范化为文件系统安全的 key（如 "b0f5860fdecb-im-bot"）。
 * 与官方插件的 normalizeAccountId 行为一致，便于共享状态目录。
 */
export function normalizeAccountId(id) {
  return String(id || "").trim().replace(/[@:]/g, "-");
}

/** 判断字符串是否为本地文件路径（无 URL scheme）。 */
export function isLocalFilePath(p) {
  return !p.includes("://");
}

/** 判断是否为 http(s) URL。 */
export function isRemoteUrl(p) {
  return p.startsWith("http://") || p.startsWith("https://");
}

/** 将任意路径形态（绝对/相对/file://）解析为绝对文件系统路径。 */
export function resolveLocalPath(p) {
  if (p.startsWith("file://")) return new URL(p).pathname;
  if (!path.isAbsolute(p)) return path.resolve(p);
  return p;
}
