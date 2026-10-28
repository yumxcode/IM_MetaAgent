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
 * Size-rotated log file: file → file.1 → … → file.N. Synchronous appends keep
 * ordering simple; only the long-lived bot process opens one (workers keep stderr).
 */
export class RotatingLogFile {
  constructor(file, { maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
    this.file = path.resolve(file); this.maxBytes = Math.max(4096, maxBytes); this.keep = Math.max(1, keep);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.open();
  }
  open() {
    this.fd = fs.openSync(this.file, "a", 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }
  rotate() {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    for (let i = this.keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch (err) { if (err.code !== "ENOENT") throw err; }
    this.open();
  }
  write(line) {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.writeSync(this.fd, line); this.size += bytes;
  }
  close() { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

/**
 * Repeated warn/error lines (same level, message and metadata) are written once
 * per window; the suppressed count is reported when the window ends.
 */
export class RepeatSuppressor {
  constructor({ windowMs = 5 * 60 * 1000, maxKeys = 500, now = Date.now } = {}) {
    this.windowMs = windowMs; this.maxKeys = maxKeys; this.now = now; this.entries = new Map();
  }
  /** Returns null to suppress, or { note } to emit (note describes earlier suppression). */
  check(key) {
    const at = this.now(), entry = this.entries.get(key);
    if (entry && at - entry.since < this.windowMs) { entry.suppressed++; entry.last = at; return null; }
    const note = entry?.suppressed ? entry.suppressed : 0;
    this.entries.delete(key); this.entries.set(key, { since: at, last: at, suppressed: 0 });
    if (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return { suppressedBefore: note };
  }
  /** Close finished windows that suppressed something; returns [{ key, count, since, last }]. */
  drain() {
    const at = this.now(), out = [];
    for (const [key, entry] of this.entries) {
      if (at - entry.since < this.windowMs) continue;
      if (entry.suppressed) out.push({ key, count: entry.suppressed, since: entry.since, last: entry.last });
      this.entries.delete(key);
    }
    return out;
  }
}

/**
 * 简易分级日志。默认 info，可通过环境变量 WEIXIN_LOG_LEVEL 调整。
 * 默认输出到 stderr（stdout 留给 QR 渲染等用户可见输出）；常驻进程可调用
 * log.useFile() 改写到按大小轮转的文件。warn/error 的重复行按窗口合并计数。
 */
export const log = {
  _level: LOG_LEVELS[ENV_LEVEL] ?? LOG_LEVELS.info,
  _sink: null,
  _repeat: new RepeatSuppressor({ windowMs: Number(process.env.IM_LOG_REPEAT_WINDOW_MS) || 5 * 60 * 1000 }),
  _drainTimer: null,
  setLevel(level) {
    const l = LOG_LEVELS[String(level).toLowerCase()];
    if (l === undefined) throw new Error(`invalid log level: ${level}`);
    this._level = l;
  },
  /** Route log lines to a rotating file. Returns the sink (or null when file is empty). */
  useFile(file, { maxBytes, keep } = {}) {
    this._sink?.close(); this._sink = null;
    if (!file) return null;
    this._sink = new RotatingLogFile(file, { maxBytes, keep });
    return this._sink;
  },
  closeFile() { this._sink?.close(); this._sink = null; },
  _write(line) {
    if (this._sink) {
      try { this._sink.write(line); return; }
      catch { /* fall back to stderr below */ }
    }
    process.stderr.write(line);
  },
  _flushRepeats() {
    for (const item of this._repeat.drain()) {
      const [level, msg] = JSON.parse(item.key);
      const seconds = Math.max(1, Math.round((item.last - item.since) / 1000));
      this._write(`${new Date().toISOString()} [${level}] (重复 ${item.count} 次，${seconds}s 内已合并) ${msg}\n`);
    }
  },
  _emit(level, msg, meta) {
    if (LOG_LEVELS[level] < this._level) return;
    const metaText = meta ? safeJson(meta) : "";
    let prefix = "";
    if (LOG_LEVELS[level] >= LOG_LEVELS.warn) {
      const decision = this._repeat.check(JSON.stringify([level, msg, metaText]));
      if (!decision) {
        if (!this._drainTimer) {
          this._drainTimer = setInterval(() => this._flushRepeats(), Math.min(this._repeat.windowMs, 60_000));
          this._drainTimer.unref?.();
        }
        return;
      }
      if (decision.suppressedBefore) prefix = `(此前已合并 ${decision.suppressedBefore} 次重复) `;
    }
    const ts = new Date().toISOString();
    this._write(metaText ? `${ts} [${level}] ${prefix}${msg} ${metaText}\n` : `${ts} [${level}] ${prefix}${msg}\n`);
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
  const sensitive = /^(?:token|bot_token|context_token|typing_ticket|aes_key|aeskey|qrcode|qrcode_img_content|local_token_list|verify_code|upload_param|upload_full_url|encrypt_query_param|encrypted_query_param|full_url)$/i;
  let safe;
  try {
    safe = JSON.stringify(JSON.parse(String(body)), (key, value) => sensitive.test(key) ? "<redacted>" : value);
  } catch {
    safe = String(body).replace(/("(?:bot_token|token|context_token|typing_ticket|aes_key|aeskey|qrcode|verify_code|upload_param|encrypt_query_param)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"<redacted>"');
  }
  return safe.length <= maxLen ? safe : `${safe.slice(0, maxLen)}…(truncated, totalLen=${safe.length})`;
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
    const abort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
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
  return String(id || "").trim().replace(/[@:]/g, "-").replace(/[\\/\u0000]/g, "_").replace(/\.\./g, "_");
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
