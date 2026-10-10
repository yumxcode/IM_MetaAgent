import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost, apiGet, buildBaseInfo, buildHeaders, buildAppHeaders,
  buildClientVersion, sanitizeBotAgent, getUpdates, getUploadUrl,
  sendMessage, notifyStart, notifyStop, classifyFetchError,
  WeixinApiError, WeixinHttpError, WeixinTimeoutError, WeixinNetworkError,
} from "../src/http.mjs";
import { CHANNEL_VERSION, ILINK_APP_CLIENT_VERSION, MessageItemType } from "../src/constants.mjs";

const BASE = "https://ilinkai.weixin.qq.com";
const response = (raw = '{"ret":0}', status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => raw });
function abortPromise(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { const err = new Error("abort"); err.name = "AbortError"; reject(err); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

test("official application headers, random UIN and encoded 2.4.9 client version", () => {
  assert.equal(CHANNEL_VERSION, "2.4.9");
  assert.equal(buildClientVersion("2.4.9"), 132105);
  assert.equal(ILINK_APP_CLIENT_VERSION, 132105);
  const first = buildHeaders({ token: " secret ", body: "你好", routeTag: "r1" });
  const second = buildHeaders();
  assert.equal(first["iLink-App-Id"], "bot");
  assert.equal(first["iLink-App-ClientVersion"], "132105");
  assert.equal(first.Authorization, "Bearer secret");
  assert.equal(first.AuthorizationType, "ilink_bot_token");
  assert.equal(first.SKRouteTag, "r1");
  assert.equal(first["Content-Length"], undefined);
  assert.notEqual(first["X-WECHAT-UIN"], second["X-WECHAT-UIN"]);
  const uint32 = Number(Buffer.from(first["X-WECHAT-UIN"], "base64").toString());
  assert.ok(Number.isInteger(uint32) && uint32 >= 0 && uint32 <= 0xffffffff);
  assert.deepEqual(buildAppHeaders({ routeTag: "r2" }), { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132105", SKRouteTag: "r2" });
  assert.equal(MessageItemType.TOOL_CALL_START, 11);
  assert.equal(MessageItemType.TOOL_CALL_RESULT, 12);
});

test("bot agent accepts safe UA products and comments with a 256-byte cap", () => {
  assert.equal(sanitizeBotAgent(undefined), "IMMetaAgent/1.1.1");
  assert.equal(sanitizeBotAgent("垃圾\n header:value"), "IMMetaAgent/1.1.1");
  assert.equal(sanitizeBotAgent("Agent/1.0 (local bridge) Other/2.0+beta"), "Agent/1.0 (local bridge) Other/2.0+beta");
  assert.equal(sanitizeBotAgent("Valid/1.0 invalid 注入 Good/2.0"), "Valid/1.0 Good/2.0");
  assert.ok(Buffer.byteLength(sanitizeBotAgent(Array.from({ length: 100 }, () => "Agent/1.0").join(" "))) <= 256);
  assert.deepEqual(buildBaseInfo({ botAgent: "MyBot/3.0" }), { channel_version: "2.4.9", bot_agent: "MyBot/3.0" });
});

test("POST injects current base_info and sendMessage returns lossless assigned ID", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => { request = { url, ...options }; return response('{"ret":0,"message_id":18446744073709551615}'); });
  const result = await sendMessage({ baseUrl: BASE, token: "test-token", msg: { to_user_id: "u", context_token: "context-secret", item_list: [] }, routeTag: "route" });
  assert.equal(result.message_id, "18446744073709551615");
  assert.equal(request.url, `${BASE}/ilink/bot/sendmessage`);
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers.Authorization, "Bearer test-token");
  assert.equal(request.headers.SKRouteTag, "route");
  const payload = JSON.parse(request.body);
  assert.equal(payload.base_info.channel_version, "2.4.9");
  assert.ok(payload.base_info.bot_agent);
  assert.equal(payload.msg.context_token, "context-secret");
});

test("QR GET sends app headers without bot auth; uint64 IDs remain lossless", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => { request = options; return response('{"status":"wait","svr_id":9007199254740993}'); });
  const result = await apiGet({ baseUrl: BASE, path: "ilink/bot/get_qrcode_status?qrcode=secret", routeTag: "route", extraHeaders: { "X-Extra": "present" } });
  assert.equal(result.status, "wait");
  assert.equal(result.svr_id, "9007199254740993");
  assert.equal(request.headers["iLink-App-Id"], "bot");
  assert.equal(request.headers["X-WECHAT-UIN"], undefined);
  assert.equal(request.headers.AuthorizationType, undefined);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers["X-Extra"], "present");
});

test("QR POST can opt out of base_info and business error throwing", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => { request = options; return response('{"ret":2,"status":"need_verifycode"}'); });
  const result = await apiPost({ baseUrl: BASE, endpoint: "ilink/bot/get_bot_qrcode", body: { bot_type: "3" }, injectBaseInfo: false, allowApiError: true });
  assert.equal(result.status, "need_verifycode");
  assert.deepEqual(JSON.parse(request.body), { bot_type: "3" });
  assert.equal(request.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(request.headers.Authorization, undefined);
});

test("upload request excludes routing and cancellation controls from JSON", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => { request = options; return response('{"upload_full_url":"https://novac2c.cdn.weixin.qq.com/upload"}'); });
  const controller = new AbortController();
  await getUploadUrl({ baseUrl: BASE, token: "t", routeTag: "route", timeoutMs: 100, abortSignal: controller.signal, filekey: "file", media_type: 1, rawsize: 3 });
  const payload = JSON.parse(request.body);
  assert.equal(payload.filekey, "file");
  assert.equal(payload.rawsize, 3);
  for (const field of ["baseUrl", "token", "routeTag", "timeoutMs", "abortSignal", "signal"]) assert.equal(payload[field], undefined);
  assert.equal(request.headers.SKRouteTag, "route");
});

test("lifecycle notifications use official endpoints and metadata", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { requests.push({ url, payload: JSON.parse(options.body) }); return response(); });
  await notifyStart({ baseUrl: BASE });
  await notifyStop({ baseUrl: BASE });
  assert.deepEqual(requests.map((request) => request.url), [`${BASE}/ilink/bot/msg/notifystart`, `${BASE}/ilink/bot/msg/notifystop`]);
  assert.ok(requests.every((request) => request.payload.base_info.channel_version === "2.4.9"));
});

for (const method of ["POST", "GET"]) {
  test(`${method} timeout remains active while response body is consumed`, async (t) => {
    let signaled;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      signaled = options.signal;
      return { ok: true, status: 200, text: () => abortPromise(options.signal) };
    });
    const request = method === "POST" ? apiPost({ baseUrl: BASE, endpoint: "test", timeoutMs: 10 }) : apiGet({ baseUrl: BASE, path: "test", timeoutMs: 10 });
    await assert.rejects(request, WeixinTimeoutError);
    assert.equal(signaled.aborted, true);
  });
}

test("external abort cancels the body immediately and retains AbortError semantics", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    queueMicrotask(() => controller.abort());
    return { ok: true, status: 200, text: () => abortPromise(options.signal) };
  });
  await assert.rejects(apiPost({ baseUrl: BASE, endpoint: "test", timeoutMs: 1000, abortSignal: controller.signal }), { name: "AbortError", message: "request aborted" });
});

test("preaborted requests never issue a network call", async (t) => {
  const controller = new AbortController(); controller.abort();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  await assert.rejects(apiGet({ baseUrl: BASE, path: "test", signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("poll timeout and stop abort return empty success with the existing cursor", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => abortPromise(options.signal));
  assert.deepEqual(await getUpdates({ baseUrl: BASE, getUpdatesBuf: "cursor", timeoutMs: 5 }), { ret: 0, msgs: [], get_updates_buf: "cursor" });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await getUpdates({ baseUrl: BASE, getUpdatesBuf: "cursor", abortSignal: controller.signal }), { ret: 0, msgs: [], get_updates_buf: "cursor" });
});

test("API -14 raises typed stale-token error without leaking a token", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response('{"ret":-14,"errmsg":"expired test-secret-token"}'));
  await assert.rejects(apiPost({ baseUrl: BASE, endpoint: "test", token: "test-secret-token" }), (error) => {
    assert.ok(error instanceof WeixinApiError);
    assert.equal(error.isSessionExpired, true);
    assert.equal(error.isStaleToken, true);
    assert.equal(error.errmsg, "[redacted]");
    assert.ok(!error.message.includes("test-secret-token"));
    return true;
  });
});

test("HTTP and malformed JSON errors omit raw response secrets", async (t) => {
  let status = 500;
  t.mock.method(globalThis, "fetch", async () => response('secret=full-secret context_token=private', status));
  for (const nextStatus of [500, 200]) {
    status = nextStatus;
    await assert.rejects(apiPost({ baseUrl: BASE, endpoint: "test" }), (error) => {
      assert.ok(error instanceof WeixinHttpError);
      assert.equal(error.body, "[redacted]");
      assert.ok(!error.message.includes("full-secret"));
      return true;
    });
  }
});

test("network cause diagnostics classify DNS/TCP/TLS without retaining raw details", async (t) => {
  for (const [code, type] of [["ENOTFOUND", "dns"], ["ECONNREFUSED", "tcp"], ["ETIMEDOUT", "tcp"], ["CERT_HAS_EXPIRED", "tls"], ["UND_ERR_SOCKET", "tcp"], ["UND_ERR_BODY_TIMEOUT", "timeout"]]) {
    const error = new Error("fetch failed secret-url", { cause: Object.assign(new Error("secret-private-host"), { code }) });
    assert.equal(classifyFetchError(error).type, type);
    assert.equal(classifyFetchError(error).code, code);
    assert.ok(!classifyFetchError(error).description.includes("secret"));
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret token URL", { cause: Object.assign(new Error("secret host"), { code: "ENOTFOUND" }) }); });
  await assert.rejects(apiPost({ baseUrl: BASE, endpoint: "test" }), (error) => {
    assert.ok(error instanceof WeixinNetworkError);
    assert.equal(error.type, "dns");
    assert.equal(error.code, "ENOTFOUND");
    assert.ok(!error.message.includes("secret"));
    assert.equal(error.cause, undefined);
    return true;
  });
});
