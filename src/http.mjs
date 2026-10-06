/** iLink Bot API client, compatible with Tencent's official 2.4.9 client. */
import {
  CHANNEL_VERSION,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_BOT_AGENT,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  SESSION_EXPIRED_ERRCODE,
} from "./constants.mjs";
import { ensureTrailingSlash, log, randomWechatUin, redactBody, redactUrl } from "./util.mjs";
import { parseJsonLossless } from "./json.mjs";

export { parseJsonLossless, parseWeixinApiJson } from "./json.mjs";

/** HTTP status / malformed-response error. Sensitive response content is omitted. */
export class WeixinHttpError extends Error {
  constructor(message, { status, endpoint, body } = {}) {
    super(message);
    this.name = "WeixinHttpError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

export class WeixinApiError extends Error {
  constructor(message, { ret, errcode, errmsg, endpoint } = {}) {
    super(message);
    this.name = "WeixinApiError";
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.endpoint = endpoint;
  }
  get isSessionExpired() {
    return this.errcode === SESSION_EXPIRED_ERRCODE || this.ret === SESSION_EXPIRED_ERRCODE;
  }
  get isStaleToken() { return this.isSessionExpired; }
}

export class WeixinTimeoutError extends Error {
  constructor(message, { endpoint, timeoutMs } = {}) {
    super(message);
    this.name = "WeixinTimeoutError";
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }
}

/** Safe network diagnostics without retaining URLs, query strings or tokens. */
export class WeixinNetworkError extends Error {
  constructor(message, { endpoint, type, code } = {}) {
    super(message);
    this.name = "WeixinNetworkError";
    this.endpoint = endpoint;
    this.type = type;
    this.code = code;
  }
}

/** Major, minor and patch occupy one byte each, matching the official client. */
export function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split(".").map((part) => parseInt(part, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** UA-style product tokens with optional ASCII comments; maximum 256 bytes. */
export function sanitizeBotAgent(raw) {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_BOT_AGENT;
  const words = raw.trim().split(/\s+/);
  const products = [];
  for (let i = 0; i < words.length; i++) {
    const product = words[i];
    if (!/^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/.test(product)) continue;
    let accepted = product;
    if (words[i + 1]?.startsWith("(")) {
      let comment = words[++i];
      while (!comment.endsWith(")") && i + 1 < words.length) comment += ` ${words[++i]}`;
      const inner = comment.slice(1, -1);
      if (comment.endsWith(")") && /^[\x20-\x27\x2a-\x7e]{1,64}$/.test(inner)) {
        accepted += ` (${inner})`;
      }
    }
    if (Buffer.byteLength([...products, accepted].join(" "), "utf8") > 256) break;
    products.push(accepted);
  }
  return products.join(" ") || DEFAULT_BOT_AGENT;
}

export function buildBaseInfo({ botAgent = process.env.WEIXIN_BOT_AGENT } = {}) {
  return { channel_version: CHANNEL_VERSION, bot_agent: sanitizeBotAgent(botAgent) };
}

/** Unauthenticated QR GET requests use only these shared application headers. */
export function buildAppHeaders({ routeTag, appId = ILINK_APP_ID, clientVersion = ILINK_APP_CLIENT_VERSION } = {}) {
  const headers = {
    "iLink-App-Id": String(appId),
    "iLink-App-ClientVersion": String(clientVersion),
  };
  if (routeTag) headers.SKRouteTag = String(routeTag);
  return headers;
}

/** The fetch implementation computes Content-Length from the actual UTF-8 body. */
export function buildHeaders({ token, routeTag, appId, clientVersion } = {}) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildAppHeaders({ routeTag, appId, clientVersion }),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

/** Network causes are inspected for classification, never copied into messages. */
export function classifyFetchError(err) {
  if (err?.name === "AbortError" || err instanceof WeixinTimeoutError) {
    return { type: "timeout", description: "request timeout" };
  }
  const causes = [];
  let current = err;
  for (let depth = 0; current && depth < 6; depth++) {
    causes.push(current);
    current = current.cause;
  }
  const diagnostics = causes.map((cause) => `${cause?.code ?? ""} ${cause?.message ?? String(cause)}`).join(" ");
  const code = causes.map((cause) => cause?.code).find((value) => typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value));
  const withCode = (type, description) => ({ type, description, ...(code ? { code } : {}) });
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(diagnostics)) return withCode("dns", "DNS resolution failed; check DNS configuration");
  if (/ECONNREFUSED/i.test(diagnostics)) return withCode("tcp", "TCP connection refused");
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(diagnostics)) return withCode("tcp", "TCP connection timeout or unreachable");
  if (/UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(diagnostics)) return withCode("timeout", "request timeout");
  if (/SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(diagnostics)) return withCode("tls", "TLS handshake error");
  if (/UND_ERR_SOCKET|ECONNRESET|EPIPE/i.test(diagnostics)) return withCode("tcp", "TCP connection interrupted");
  return { type: "unknown", description: "network request failed" };
}

function abortError() {
  const err = new Error("request aborted");
  err.name = "AbortError";
  return err;
}

function safeLabel(raw) {
  // API labels are diagnostic identifiers, never a place to retain URL queries.
  return String(raw || "iLink API").split("?")[0].replace(/[^A-Za-z0-9_./ -]/g, "").slice(0, 100);
}

function safeApiMessage(raw, token) {
  if (!raw) return "";
  // errmsg is arbitrary remote content; structured/token-containing responses
  // are omitted entirely instead of relying on partial redaction.
  const value = String(raw);
  if ((token && value.includes(token.trim())) || /bearer\s|token|aes_?key|qrcode|https?:\/\/|[{}\[\]]/i.test(value)) return "[redacted]";
  return redactBody(value, 160);
}

/** Timeout and external cancellation remain active while consuming the body. */
async function fetchJson({ baseUrl, endpoint, method, headers, body, timeoutMs, label, signal, abortSignal }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  const name = safeLabel(label ?? endpoint);
  const external = abortSignal ?? signal;
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const onAbort = () => controller.abort();
  if (external?.aborted) throw abortError();
  external?.addEventListener("abort", onAbort, { once: true });
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  }
  log.debug(`${method} ${name}`, { url: redactUrl(url), ...(body === undefined ? {} : { bodyBytes: Buffer.byteLength(body) }) });
  try {
    const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal, redirect: "error" });
    const rawText = await res.text();
    // Covers implementations that resolve despite an abort during body reading.
    if (external?.aborted) throw abortError();
    if (timedOut) throw new WeixinTimeoutError(`${name}: timeout after ${timeoutMs}ms`, { endpoint: name, timeoutMs });
    log.debug(`${name} status=${res.status}`, { responseBytes: Buffer.byteLength(rawText) });
    if (!res.ok) {
      throw new WeixinHttpError(`${name}: HTTP ${res.status}`, { status: res.status, endpoint: name, body: "[redacted]" });
    }
    try { return parseJsonLossless(rawText); } catch {
      throw new WeixinHttpError(`${name}: response is not valid JSON`, { status: res.status, endpoint: name, body: "[redacted]" });
    }
  } catch (err) {
    if (external?.aborted) throw abortError();
    if (err instanceof WeixinHttpError || err instanceof WeixinTimeoutError) throw err;
    if (timedOut || err?.name === "AbortError") {
      throw new WeixinTimeoutError(`${name}: timeout after ${timeoutMs}ms`, { endpoint: name, timeoutMs });
    }
    const classified = classifyFetchError(err);
    log.warn(`${name}: fetch failed`, classified);
    throw new WeixinNetworkError(`${name}: ${classified.description}${classified.code ? ` (${classified.code})` : ""}`, { endpoint: name, ...classified });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

export async function apiPost(opts) {
  const {
    baseUrl, endpoint, body = {}, token, routeTag,
    timeoutMs = DEFAULT_API_TIMEOUT_MS, label = endpoint,
    injectBaseInfo = true, allowApiError = false,
    extraHeaders = {}, signal, abortSignal, botAgent,
  } = opts;
  const payload = injectBaseInfo ? { ...body, base_info: buildBaseInfo({ botAgent }) } : body;
  const response = await fetchJson({
    baseUrl, endpoint, method: "POST", timeoutMs, label, signal, abortSignal,
    headers: { ...buildHeaders({ token, routeTag }), ...extraHeaders },
    body: JSON.stringify(payload),
  });
  if (!allowApiError && response && typeof response === "object") {
    const { ret, errcode } = response;
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      const errmsg = safeApiMessage(response.errmsg, token);
      throw new WeixinApiError(`${safeLabel(label)}: ret=${ret} errcode=${errcode} errmsg=${errmsg}`, { ret, errcode, errmsg, endpoint: safeLabel(label) });
    }
  }
  return response;
}

/** GET preserves business/status response fields for the login state machine. */
export function apiGet({ baseUrl, path, endpoint = path, token, timeoutMs = DEFAULT_API_TIMEOUT_MS, label = endpoint, routeTag, extraHeaders = {}, signal, abortSignal } = {}) {
  const headers = { ...buildAppHeaders({ routeTag }), ...extraHeaders };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return fetchJson({ baseUrl, endpoint, method: "GET", timeoutMs, label, headers, signal, abortSignal });
}

/** Internal timeout and external stop are normal long-poll control flow. */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", get_updates_buf, timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS, routeTag, signal, abortSignal } = {}) {
  const buf = get_updates_buf ?? getUpdatesBuf;
  try {
    return await apiPost({ baseUrl, endpoint: "ilink/bot/getupdates", body: { get_updates_buf: buf }, token, timeoutMs, label: "getUpdates", routeTag, signal, abortSignal });
  } catch (err) {
    if (err instanceof WeixinTimeoutError || err?.name === "AbortError") {
      log.debug("getUpdates: long-poll ended without messages");
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export function getUploadUrl({ baseUrl, token, routeTag, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal, abortSignal, ...req } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/getuploadurl", body: req, token, routeTag, timeoutMs, signal, abortSignal, label: "getUploadUrl" });
}

export function sendMessage({ baseUrl, token, msg, timeoutMs, routeTag, signal, abortSignal } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/sendmessage", body: { msg }, token, timeoutMs, routeTag, signal, abortSignal, label: "sendMessage" });
}

export function getConfig({ baseUrl, token, ilinkUserId, contextToken, routeTag, timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal, abortSignal } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/getconfig", body: { ilink_user_id: ilinkUserId, context_token: contextToken }, token, routeTag, timeoutMs, signal, abortSignal, label: "getConfig" });
}

export function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status, routeTag, timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal, abortSignal } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/sendtyping", body: { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status }, token, routeTag, timeoutMs, signal, abortSignal, label: "sendTyping" });
}

export function notifyStart({ baseUrl, token, routeTag, timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal, abortSignal } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/msg/notifystart", body: {}, token, routeTag, timeoutMs, signal, abortSignal, label: "notifyStart" });
}

/** Call without the stopped polling signal so the notification can finish. */
export function notifyStop({ baseUrl, token, routeTag, timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal, abortSignal } = {}) {
  return apiPost({ baseUrl, endpoint: "ilink/bot/msg/notifystop", body: {}, token, routeTag, timeoutMs, signal, abortSignal, label: "notifyStop" });
}

export { apiPost as _apiPost, apiGet as _apiGet };
