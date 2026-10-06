import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinBot } from "../src/index.mjs";
import { saveAccount, loadAccount, deleteAccount } from "../src/auth.mjs";
import { WeixinApiError } from "../src/http.mjs";
import { encryptAesEcb } from "../src/crypto.mjs";
import { pauseSession, _resetSessionGuardForTest } from "../src/session-guard.mjs";

let stateDir;
let oldStateDir;
let oldOpenclawStateDir;
const bots = [];
const ACCOUNT = "index-bot-A";
const USER = "index-user";
const BASE = "https://ilinkhk.weixin.qq.com";
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-index-test-"));
  oldStateDir = process.env.WEIXIN_STATE_DIR;
  oldOpenclawStateDir = process.env.OPENCLAW_STATE_DIR;
  delete process.env.WEIXIN_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  _resetSessionGuardForTest();
  saveAccount(ACCOUNT, { token: "index-token-A", baseUrl: BASE, userId: USER });
});
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
  if (oldStateDir === undefined) delete process.env.WEIXIN_STATE_DIR; else process.env.WEIXIN_STATE_DIR = oldStateDir;
  if (oldOpenclawStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = oldOpenclawStateDir;
  _resetSessionGuardForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
function bot(options = {}) {
  const instance = new WeixinBot({ autoDownloadMedia: false, ...options });
  instance.setDefaultAccount(ACCOUNT);
  bots.push(instance);
  return instance;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function holdPolling(onReady) {
  return async (options) => {
    onReady(options);
    if (options.abortSignal.aborted) return;
    await new Promise(resolve => options.abortSignal.addEventListener("abort", resolve, { once: true }));
  };
}
function fakeSend(t, id = "18446744073709551615") {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options, msg: JSON.parse(options.body).msg });
    return new Response(`{"ret":0,"message_id":${id}}`, { status: 200 });
  });
  return calls;
}

test("stored redirected account URL is used and explicit bot URL takes precedence", async (t) => {
  const calls = fakeSend(t);
  const saved = bot({ quoteCache: { enabled: false } });
  await saved.sendText({ to: USER, text: "test", contextToken: "ctx" });
  assert.equal(new URL(calls[0].url).origin, BASE);
  assert.equal(saved.getAccountInfo().baseUrl, BASE);
  assert.equal(saved.getAccountInfo().token, undefined);
  const override = bot({ baseUrl: "https://ilinkai.weixin.qq.com", quoteCache: { enabled: false } });
  await override.sendText({ to: USER, text: "test", contextToken: "ctx" });
  assert.equal(new URL(calls[1].url).origin, "https://ilinkai.weixin.qq.com");
});

test("sent uint64 IDs populate quote cache and ID-only replies restore text context", async (t) => {
  const calls = fakeSend(t);
  const instance = bot();
  const sent = await instance.sendText({ to: USER, text: "/tasks delete 1", contextToken: "ctx", runId: "task-run" });
  assert.equal(sent.serverMessageId, "18446744073709551615");
  assert.equal(calls[0].msg.run_id, "task-run");
  const received = [];
  instance.on("message", msg => received.push(msg));
  await instance._handleInbound({ message_id: "9007199254740993", from_user_id: USER, message_type: 1, context_token: "new-ctx", item_list: [{ type: 1, text_item: { text: "最近进展" }, ref_msg: { svr_id: sent.serverMessageId } }] }, ACCOUNT);
  assert.equal(received[0].commandText, "最近进展");
  assert.equal(received[0].quotes[0].body, "/tasks delete 1");
  assert.equal(received[0].quotes[0].serverMessageId, "18446744073709551615");
  assert.equal(received[0].messageId, "9007199254740993");
  assert.equal(instance._quoteStore.find(ACCOUNT, USER, "9007199254740993").body, "最近进展");
});

test("reply inherits account, current conversation token and run ID", async (t) => {
  const calls = fakeSend(t);
  const instance = bot({ quoteCache: { enabled: false } });
  await instance.reply({ accountId: ACCOUNT, fromUserId: USER, contextToken: "inbound-context", runId: "inbound-run" }, "回复");
  assert.equal(calls[0].msg.to_user_id, USER);
  assert.equal(calls[0].msg.context_token, "inbound-context");
  assert.equal(calls[0].msg.run_id, "inbound-run");
  await instance._handleInbound({ from_user_id: USER, context_token: "cached-context", message_type: 1, item_list: [{ type: 1, text_item: { text: "hello" } }] }, ACCOUNT);
  await instance.sendToolProgress({ to: USER, toolName: "tasks", toolCallId: "call", runId: "run" });
  assert.equal(calls[1].msg.context_token, "cached-context");
  assert.equal(calls[1].msg.run_id, "run");
  assert.equal(calls[1].msg.item_list[0].type, 11);
});

test("bot echoes are exposed as raw events without triggering replies", async () => {
  const instance = bot({ quoteCache: { enabled: false } });
  let rawCount = 0;
  let messageCount = 0;
  instance.on("raw", () => rawCount++);
  instance.on("message", () => messageCount++);
  await instance._handleInbound({ message_type: 2, from_user_id: USER, item_list: [{ type: 1, text_item: { text: "echo" } }] }, ACCOUNT);
  assert.equal(rawCount, 1);
  assert.equal(messageCount, 0);
});

test("encrypted full_url media is downloaded, cached and restored by an ID-only reply", async (t) => {
  const mediaUrl = "https://novac2c.cdn.weixin.qq.com/object?signature=test";
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("incoming file content");
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => { fetchCount++; assert.equal(url, mediaUrl); return new Response(encryptAesEcb(plaintext, key)); });
  const instance = bot({ autoDownloadMedia: true });
  const received = [];
  instance.on("message", msg => received.push(msg));
  await instance._handleInbound({ message_id: "9007199254740992", from_user_id: USER, message_type: 1, item_list: [{ type: 4, file_item: { file_name: "incoming.txt", media: { full_url: mediaUrl, aes_key: Buffer.from(key.toString("hex")).toString("base64") } } }] }, ACCOUNT);
  assert.equal(fetchCount, 1);
  assert.equal(fs.readFileSync(received[0].mediaPath).toString(), plaintext.toString());
  assert.equal(received[0].fileName, "incoming.txt");
  assert.equal(received[0].mediaType, "text/plain");
  assert.ok(received[0].mediaPath.startsWith(stateDir));
  await instance._handleInbound({ message_id: "9007199254740993", from_user_id: USER, message_type: 1, item_list: [{ type: 1, text_item: { text: "解释文件" }, ref_msg: { svr_id: "9007199254740992" } }] }, ACCOUNT);
  assert.equal(fetchCount, 1);
  assert.equal(received[1].mediaPath, received[0].mediaPath);
  assert.equal(received[1].fileName, "incoming.txt");
  assert.equal(received[1].commandText, "解释文件");
});

test("per-account lifecycle stop uses refreshed credentials and independent notification signal", async () => {
  const ready = deferred();
  const events = [];
  const instance = bot({ quoteCache: { enabled: false },
    pollingFn: holdPolling(options => { events.push({ type: "poll", options }); ready.resolve(); }),
    notifyStartFn: async options => events.push({ type: "start", options }),
    notifyStopFn: async options => events.push({ type: "stop", options }),
  });
  const running = instance.start();
  await ready.promise;
  saveAccount(ACCOUNT, { token: "refreshed-token", baseUrl: "https://ilinkai.weixin.qq.com" });
  await instance.stop(ACCOUNT);
  await running;
  assert.deepEqual(events.map(event => event.type), ["start", "poll", "stop"]);
  assert.equal(events[0].options.baseUrl, BASE);
  assert.equal(events[0].options.token, "index-token-A");
  assert.equal(events[2].options.baseUrl, "https://ilinkai.weixin.qq.com");
  assert.equal(events[2].options.token, "refreshed-token");
  assert.equal(events[2].options.signal, undefined);
  assert.equal(events[2].options.abortSignal, undefined);
  assert.equal(instance._polling.size, 0);
});

test("stopping one of two accounts leaves the other polling and stop-all closes cache", async () => {
  const second = "index-bot-B";
  saveAccount(second, { token: "index-token-B", baseUrl: "https://ilinkai.weixin.qq.com" });
  const readyA = deferred(), readyB = deferred();
  const starts = [], stops = [];
  const instance = bot({
    pollingFn: holdPolling(options => (options.accountId === ACCOUNT ? readyA : readyB).resolve()),
    notifyStartFn: async options => starts.push(options.token),
    notifyStopFn: async options => stops.push(options.token),
  });
  const runningA = instance.start({ accountId: ACCOUNT });
  const runningB = instance.start({ accountId: second });
  await Promise.all([readyA.promise, readyB.promise]);
  assert.equal(instance._polling.size, 2);
  await instance.stop(ACCOUNT); await runningA;
  assert.equal(instance._polling.size, 1);
  assert.equal(instance._polling.has(second), true);
  assert.deepEqual(stops, ["index-token-A"]);
  await instance.stop(); await runningB;
  assert.deepEqual(starts.sort(), ["index-token-A", "index-token-B"]);
  assert.deepEqual(stops.sort(), ["index-token-A", "index-token-B"]);
  assert.equal(instance._quoteStore, null);
});

test("lifecycle notification failures do not prevent polling or clean shutdown", async () => {
  const ready = deferred();
  let polled = 0;
  const instance = bot({ quoteCache: { enabled: false },
    pollingFn: holdPolling(() => { polled++; ready.resolve(); }),
    notifyStartFn: async () => { throw new Error("mock start failure"); },
    notifyStopFn: async () => { throw new Error("mock stop failure"); },
  });
  const controller = new AbortController();
  const running = instance.start({ signal: controller.signal });
  await ready.promise;
  controller.abort();
  await running;
  assert.equal(polled, 1);
  assert.equal(instance._polling.size, 0);
});

test("preaborted start skips startup notification and polling", async () => {
  const controller = new AbortController(); controller.abort();
  let starts = 0, polls = 0;
  const instance = bot({ quoteCache: { enabled: false }, pollingFn: async () => polls++, notifyStartFn: async () => starts++, notifyStopFn: async () => {} });
  await instance.start({ signal: controller.signal });
  assert.equal(starts, 0);
  assert.equal(polls, 0);
  assert.equal(instance._polling.size, 0);
});

test("session cooldown blocks outbound requests before fetch", async (t) => {
  const calls = fakeSend(t);
  const instance = bot({ quoteCache: { enabled: false } });
  pauseSession(ACCOUNT);
  await assert.rejects(instance.sendText({ to: USER, text: "test", contextToken: "ctx" }), /session paused/);
  assert.equal(calls.length, 0);
  assert.equal(instance.isPaused(), true);
  assert.equal(loadAccount(ACCOUNT).token, "index-token-A");
});

test("ret-only stale-token errors emit session-expired and stop still completes", async () => {
  const expired = [];
  const instance = bot({ quoteCache: { enabled: false },
    pollingFn: async options => { await options.onError(new WeixinApiError("getUpdates: ret=-14", { ret: -14 })); },
    notifyStartFn: async () => {}, notifyStopFn: async () => {},
  });
  instance.on("session-expired", accountId => expired.push(accountId));
  await instance.start();
  assert.deepEqual(expired, [ACCOUNT]);
  assert.equal(instance._polling.size, 0);
});

test("credentials removed during polling do not block stop and retain notification credentials", async () => {
  const ready = deferred();
  let stoppedWith;
  const instance = bot({ quoteCache: { enabled: false },
    pollingFn: holdPolling(() => ready.resolve()),
    notifyStartFn: async () => {}, notifyStopFn: async options => { stoppedWith = options; },
  });
  const running = instance.start();
  await ready.promise;
  deleteAccount(ACCOUNT);
  await instance.stop(ACCOUNT); await running;
  assert.equal(stoppedWith.token, "index-token-A");
  assert.equal(stoppedWith.baseUrl, BASE);
  assert.equal(instance._polling.size, 0);
});

test("only final streaming text is cached under the final server-assigned ID", async (t) => {
  const calls = [];
  const ids = ["9007199254740992", "9007199254740993", "18446744073709551615"];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(JSON.parse(options.body).msg);
    return new Response(`{"ret":0,"message_id":${ids[calls.length - 1]}}`, { status: 200 });
  });
  const instance = bot();
  const stream = instance.createReplyStream({ to: USER, contextToken: "ctx", runId: "run-stream" });
  const first = stream.push("第一段");
  const second = stream.push("第二段");
  const final = stream.finish();
  const result = await final; await Promise.all([first, second]);
  assert.equal(result.serverMessageId, ids[2]);
  assert.equal(instance._quoteStore.find(ACCOUNT, USER, ids[0]), null);
  assert.equal(instance._quoteStore.find(ACCOUNT, USER, ids[1]), null);
  assert.equal(instance._quoteStore.find(ACCOUNT, USER, ids[2]).body, "第一段第二段");
  assert.deepEqual(calls.map(call => call.message_state), [1, 1, 2]);
});

test("remote outbound files are copied into quote cache before temporary downloads are removed", async (t) => {
  const origin = "https://example.test/report.txt";
  const content = "远程报告内容";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(String(url));
    if (String(url) === origin) return new Response(content, { headers: { "content-type": "text/plain" } });
    if (new URL(url).pathname === "/ilink/bot/getuploadurl") return new Response('{"ret":0,"upload_full_url":"https://novac2c.cdn.weixin.qq.com/upload-signed","upload_param":"signed-upload"}');
    if (String(url) === "https://novac2c.cdn.weixin.qq.com/upload-signed") return new Response(null, { headers: { "x-encrypted-param": "download-reference" } });
    if (new URL(url).pathname === "/ilink/bot/sendmessage") return new Response('{"ret":0,"message_id":18446744073709551615}');
    throw new Error(`Unexpected fake request ${new URL(url).pathname}`);
  });
  const temporaryDir = path.join(stateDir, "remote-downloads");
  const instance = bot();
  await instance.sendMedia({ to: USER, mediaUrl: origin, contextToken: "ctx", destDir: temporaryDir });
  assert.equal(requests.length, 4);
  assert.deepEqual(fs.readdirSync(temporaryDir), []);
  const cached = instance._quoteStore.find(ACCOUNT, USER, "18446744073709551615");
  assert.ok(cached.mediaPath.startsWith(stateDir));
  assert.equal(fs.readFileSync(cached.mediaPath, "utf8"), content);
  assert.equal(cached.mediaMime, "text/plain");
});

test("logout removes persisted quote history even when no store was already open", async (t) => {
  fakeSend(t);
  const original = bot();
  await original.sendText({ to: USER, text: "private cached reply", contextToken: "ctx" });
  assert.ok(original._quoteStore.find(ACCOUNT, USER, "18446744073709551615"));
  await original.stop();
  const cleanup = bot();
  assert.equal(cleanup._quoteStore, null);
  await cleanup.logout(ACCOUNT);
  assert.equal(loadAccount(ACCOUNT), null);
  const reopened = await cleanup._ensureQuoteStore();
  assert.equal(reopened.find(ACCOUNT, USER, "18446744073709551615"), null);
});

test("default account follows the latest successful login while explicit selection stays stable", () => {
  const accountFile = path.join(stateDir, "weixin-bot", "accounts", ACCOUNT + ".json");
  fs.writeFileSync(accountFile, JSON.stringify({ ...loadAccount(ACCOUNT), savedAt: "2020-01-01T00:00:00Z" }));
  saveAccount("latest-bot", { token: "latest-token" });
  const instance = new WeixinBot({ quoteCache: { enabled: false } });
  bots.push(instance);
  assert.equal(instance.getDefaultAccount(), "latest-bot");
  instance.setDefaultAccount(ACCOUNT);
  assert.equal(instance.getDefaultAccount(), ACCOUNT);
});
