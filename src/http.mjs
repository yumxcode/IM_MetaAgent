/**
 * iLink Bot HTTP 客户端
 *
 * 封装所有与 ilinkai.weixin.qq.com 的通信：
 *  - 统一请求头（Content-Type / AuthorizationType / X-WECHAT-UIN / Bearer）
 *  - base_info 自动注入
 *  - 超时与 AbortController
 *  - 错误分类（HTTP 错误 / API 业务错误 / Session 过期 / 超时）
 *
 * 与官方插件的 api 模块行为对齐，但去除了框架依赖。
 */
import {
  CHANNEL_VERSION,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  SESSION_EXPIRED_ERRCODE,
} from "./constants.mjs";
import {
  ensureTrailingSlash,
  log,
  randomWechatUin,
  redactBody,
  redactUrl,
} from "./util.mjs";

// ---------------------------------------------------------------------------
// 自定义错误类型
// ---------------------------------------------------------------------------

/** HTTP 层错误（非 2xx 状态码）。 */
export class WeixinHttpError extends Error {
  constructor(message, { status, endpoint, body } = {}) {
    super(message);
    this.name = "WeixinHttpError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

/** API 业务错误（ret !== 0 或 errcode !== 0）。 */
export class WeixinApiError extends Error {
  constructor(message, { ret, errcode, errmsg, endpoint } = {}) {
    super(message);
    this.name = "WeixinApiError";
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.endpoint = endpoint;
  }

  /** Session 是否过期（errcode=-14 或 ret=-14）。 */
  get isSessionExpired() {
    return this.errcode === SESSION_EXPIRED_ERRCODE || this.ret === SESSION_EXPIRED_ERRCODE;
  }
}

/** 请求超时（AbortError）。 */
export class WeixinTimeoutError extends Error {
  constructor(message, { endpoint, timeoutMs } = {}) {
    super(message);
    this.name = "WeixinTimeoutError";
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// base_info
// ---------------------------------------------------------------------------

export function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

// ---------------------------------------------------------------------------
// 请求头构建
// ---------------------------------------------------------------------------

/**
 * 构建请求头。每次请求生成新的 X-WECHAT-UIN（随机 uint32 → base64）防重放。
 */
export function buildHeaders({ token, body, routeTag } = {}) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  if (routeTag) {
    headers.SKRouteTag = String(routeTag);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 底层 fetch 封装
// ---------------------------------------------------------------------------

/**
 * 通用 POST JSON 请求。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.endpoint - 形如 "ilink/bot/sendmessage"
 * @param {object} opts.body - 请求体对象（未序列化）
 * @param {string} [opts.token]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.label] - 日志标签
 * @param {string} [opts.routeTag]
 * @param {boolean} [opts.injectBaseInfo=true] - 是否自动合并 base_info
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
export async function apiPost(opts) {
  const {
    baseUrl,
    endpoint,
    body,
    token,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    label = endpoint,
    routeTag,
    injectBaseInfo = true,
  } = opts;

  const payload = injectBaseInfo ? { ...body, base_info: buildBaseInfo() } : body;
  const bodyStr = JSON.stringify(payload);
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();

  const headers = buildHeaders({ token, body: bodyStr, routeTag });
  log.debug(`POST ${label}`, { url: redactUrl(url), body: redactBody(bodyStr) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new WeixinTimeoutError(`${label}: timeout after ${timeoutMs}ms`, { endpoint: label, timeoutMs });
    }
    throw err;
  }
  clearTimeout(timer);

  const rawText = await res.text();
  log.debug(`${label} status=${res.status}`, { raw: redactBody(rawText) });

  if (!res.ok) {
    throw new WeixinHttpError(`${label} HTTP ${res.status}: ${rawText}`, {
      status: res.status,
      endpoint: label,
      body: rawText,
    });
  }

  let resp;
  try {
    resp = JSON.parse(rawText);
  } catch {
    throw new WeixinHttpError(`${label}: response is not valid JSON: ${rawText}`, {
      status: res.status,
      endpoint: label,
      body: rawText,
    });
  }

  // 统一业务错误检测：ret !== 0 或 errcode !== 0
  const ret = resp.ret;
  const errcode = resp.errcode;
  const isApiError = (ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0);
  if (isApiError) {
    throw new WeixinApiError(
      `${label}: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ""}`,
      { ret, errcode, errmsg: resp.errmsg, endpoint: label },
    );
  }

  return resp;
}

/**
 * 通用 GET 请求（用于 QR 码相关接口，它们是 GET）。
 */
export async function apiGet(opts) {
  const {
    baseUrl,
    path,
    token,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    label = path,
    routeTag,
    extraHeaders = {},
  } = opts;

  const url = new URL(path, ensureTrailingSlash(baseUrl)).toString();
  const headers = { ...extraHeaders };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  if (routeTag) headers.SKRouteTag = String(routeTag);

  log.debug(`GET ${label}`, { url: redactUrl(url) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new WeixinTimeoutError(`${label}: timeout after ${timeoutMs}ms`, { endpoint: label, timeoutMs });
    }
    throw err;
  }
  clearTimeout(timer);

  const rawText = await res.text();
  log.debug(`${label} status=${res.status}`, { raw: redactBody(rawText) });

  if (!res.ok) {
    throw new WeixinHttpError(`${label} HTTP ${res.status}: ${rawText}`, {
      status: res.status,
      endpoint: label,
      body: rawText,
    });
  }
  return JSON.parse(rawText);
}

// ---------------------------------------------------------------------------
// 具体 API 封装
// ---------------------------------------------------------------------------

/**
 * 长轮询获取新消息。
 * 服务器会 hold 住连接直到有消息或超时。
 *
 * 客户端超时（AbortError）被特殊处理：返回 ret=0 的空响应，调用方可直接重试。
 * 这是长轮询的正常行为，不是错误。
 *
 * @returns {Promise<{ret:number, msgs:array, get_updates_buf:string, longpolling_timeout_ms?:number, errcode?:number, errmsg?:string}>}
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS, routeTag } = {}) {
  try {
    return await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf },
      token,
      timeoutMs,
      label: "getUpdates",
      routeTag,
    });
  } catch (err) {
    if (err instanceof WeixinTimeoutError) {
      log.debug(`getUpdates: long-poll timeout (normal), returning empty response`);
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/** 获取 CDN 预签名上传地址。 */
export function getUploadUrl({ baseUrl, token, ...req } = {}) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: req,
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
}

/** 发送消息（文字/图片/文件/视频/语音）。 */
export function sendMessage({ baseUrl, token, msg, timeoutMs, routeTag } = {}) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: { msg },
    token,
    timeoutMs,
    label: "sendMessage",
    routeTag,
  });
}

/** 获取账号配置（含 typing_ticket）。 */
export function getConfig({ baseUrl, token, ilinkUserId, contextToken, routeTag } = {}) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
    },
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
    routeTag,
  });
}

/** 发送/取消"正在输入"状态。 */
export function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status, routeTag } = {}) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    },
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
    routeTag,
  });
}

// 暴露内部 fetch 包装，供 auth.mjs 复用
export { apiPost as _apiPost, apiGet as _apiGet };
