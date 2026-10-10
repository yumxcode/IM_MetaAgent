import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let auth;
let stateDir;
let oldFetch;
let oldStateDir;
let sequence = 0;

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-auth-test-"));
  oldStateDir = process.env.WEIXIN_STATE_DIR;
  process.env.WEIXIN_STATE_DIR = stateDir;
  oldFetch = globalThis.fetch;
  auth = await import(`../src/auth.mjs?auth-test=${++sequence}`);
});

afterEach(() => {
  globalThis.fetch = oldFetch;
  if (oldStateDir === undefined) delete process.env.WEIXIN_STATE_DIR;
  else process.env.WEIXIN_STATE_DIR = oldStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function fakeFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.ok(responses.length, `Unexpected request ${new URL(url).pathname}`);
    const item = responses.shift();
    if (item instanceof Error) throw item;
    if (typeof item === "function") return item(url, options);
    return new Response(JSON.stringify(item), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const qr = (id = "secret-qr") => ({ qrcode: id, qrcode_img_content: `https://weixin.qq.com/qr/${id}` });
const confirmed = (extra = {}) => ({ status: "confirmed", ilink_bot_id: "test@im.bot", bot_token: "secret-bot-token", ilink_user_id: "user-123", ...extra });
async function startAndWait(options = {}) {
  const start = await auth.startLogin(options);
  assert.ok(start.qrcodeUrl);
  return auth.waitForLogin({ ...options, sessionKey: start.sessionKey, pollIntervalMs: 0 });
}

test("QR fetch is POST with at most 10 recent local tokens and official app headers", async () => {
  for (let i = 0; i < 12; i++) auth.saveAccount(`bot${i}`, { token: `token-${i}` });
  auth.saveAccount("empty", { token: "  " });
  const calls = fakeFetch([qr()]);
  const result = await auth.startLogin({ routeTag: "route-1" });
  assert.ok(result.qrcodeUrl);
  const request = calls[0];
  assert.equal(request.options.method, "POST");
  assert.equal(new URL(request.url).searchParams.get("bot_type"), "3");
  assert.deepEqual(JSON.parse(request.options.body), { local_token_list: Array.from({ length: 10 }, (_, i) => `token-${11 - i}`) });
  assert.ok(request.options.headers["iLink-App-Id"]);
  assert.ok(Number(request.options.headers["iLink-App-ClientVersion"]) > 1);
  assert.equal(request.options.headers.SKRouteTag, "route-1");
  assert.equal(request.options.headers.Authorization, undefined);
});

test("valid confirmation persists normalized credentials without replacing sync state", async () => {
  auth.saveSyncBuf("test@im.bot", "existing-cursor");
  fakeFetch([qr(), confirmed()]);
  const result = await startAndWait();
  assert.equal(result.connected, true);
  assert.equal(result.accountId, "test-im.bot");
  assert.equal(result.baseUrl, "https://ilinkai.weixin.qq.com");
  assert.equal(auth.loadAccount(result.accountId).token, "secret-bot-token");
  assert.equal(auth.loadSyncBuf(result.accountId), "existing-cursor");
  assert.equal(fs.statSync(auth._paths.accountFilePath(result.accountId)).mode & 0o777, 0o600);
});

test("confirmation missing token does not claim success or overwrite existing credentials", async () => {
  const saved = auth.saveAccount("test@im.bot", { token: "valid-old-token", userId: "original-user" });
  fakeFetch([qr(), confirmed({ bot_token: undefined })]);
  const result = await startAndWait();
  assert.equal(result.connected, false);
  assert.deepEqual(auth.loadAccount("test@im.bot"), saved);
});

test("confirmation without account ID fails and stores no credentials", async () => {
  fakeFetch([qr(), confirmed({ ilink_bot_id: undefined })]);
  const result = await startAndWait();
  assert.equal(result.connected, false);
  assert.deepEqual(auth.listAccountIds(), []);
});

test("async pairing code callback submits verify_code and clears it after scaned", async () => {
  const calls = fakeFetch([qr(), { status: "need_verifycode" }, { status: "scaned" }, confirmed()]);
  const prompts = [];
  const result = await startAndWait({ onVerifyCode: async (info) => { prompts.push(info); return " 123456 "; } });
  assert.equal(result.connected, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].attempt, 1);
  assert.equal(new URL(calls[2].url).searchParams.get("verify_code"), "123456");
  assert.equal(new URL(calls[3].url).searchParams.has("verify_code"), false);
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

test("incorrect pairing codes stop after three submitted attempts", async () => {
  fakeFetch([qr(), ...Array.from({ length: 4 }, () => ({ status: "need_verifycode" }))]);
  let attempts = 0;
  const result = await startAndWait({ onVerifyCode: async () => { attempts++; return "111111"; } });
  assert.equal(result.connected, false);
  assert.equal(attempts, 3);
  assert.match(result.message, /多次不匹配/);
});

test("non-TTY pairing is actionable and can resume using the same session", async () => {
  const calls = fakeFetch([qr(), { status: "need_verifycode" }, confirmed()]);
  const start = await auth.startLogin();
  const result = await auth.waitForLogin({ sessionKey: start.sessionKey, pollIntervalMs: 0 });
  assert.equal(result.connected, false);
  assert.equal(result.requiresVerifyCode, true);
  assert.equal(result.sessionKey, start.sessionKey);
  assert.match(result.message, /onVerifyCode/);
  const resumed = await auth.waitForLogin({ sessionKey: start.sessionKey, verifyCode: "789012", pollIntervalMs: 0 });
  assert.equal(resumed.connected, true);
  assert.equal(new URL(calls[2].url).searchParams.get("verify_code"), "789012");
});

test("verify_code_blocked refreshes through caller's QR renderer", async () => {
  fakeFetch([qr("first"), { status: "verify_code_blocked" }, qr("second"), confirmed()]);
  const rendered = [];
  const result = await auth.login({ onRender: async (url) => rendered.push(url), pollIntervalMs: 0 });
  assert.equal(result.connected, true);
  assert.deepEqual(rendered, [qr("first").qrcode_img_content, qr("second").qrcode_img_content]);
});

test("QR refresh is bounded for repeated blocked or expired statuses", async () => {
  fakeFetch([qr("first"), { status: "expired" }, qr("second"), { status: "verify_code_blocked" }, qr("third"), { status: "expired" }]);
  const rendered = [];
  const result = await startAndWait({ onRender: (url) => rendered.push(url) });
  assert.equal(result.connected, false);
  assert.equal(rendered.length, 2);
});

test("validated HTTPS redirect changes polling and persists the effective base URL", async () => {
  const calls = fakeFetch([qr(), { status: "scaned_but_redirect", redirect_host: "ilinkhk.weixin.qq.com" }, confirmed()]);
  const result = await startAndWait();
  assert.equal(new URL(calls[2].url).origin, "https://ilinkhk.weixin.qq.com");
  assert.equal(result.baseUrl, "https://ilinkhk.weixin.qq.com");
  assert.equal(auth.loadAccount(result.accountId).baseUrl, result.baseUrl);
});

test("unsafe server redirect is rejected before sending QR or pairing data", async () => {
  for (const redirect_host of ["http://ilinkhk.weixin.qq.com", "evil.example", "ilinkai.weixin.qq.com@evil.example", "ilinkai.weixin.qq.com/evil", "https://ilinkai.weixin.qq.com:444"]) {
    const calls = fakeFetch([qr(), { status: "scaned_but_redirect", redirect_host }]);
    const result = await startAndWait();
    assert.equal(result.connected, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(auth.listAccountIds(), []);
  }
});

test("server redirect loops stop after a bounded number of polls", async () => {
  const calls = fakeFetch([qr(), ...Array.from({ length: 6 }, () => ({ status: "scaned_but_redirect", redirect_host: "ilinkhk.weixin.qq.com" }))]);
  const result = await startAndWait();
  assert.equal(result.connected, false);
  assert.equal(calls.length, 7);
  assert.match(result.message, /重定向次数过多/);
});

test("already-bound account reuses a unique valid credential without writing state", async () => {
  const saved = auth.saveAccount("bound@im.bot", { token: "existing-token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "old-user" });
  fakeFetch([qr(), { status: "binded_redirect", ilink_bot_id: "bound@im.bot" }]);
  const result = await startAndWait();
  assert.equal(result.connected, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(result.accountId, "bound-im.bot");
  assert.equal(result.token, "existing-token");
  assert.deepEqual(auth.loadAccount(result.accountId), saved);
});

test("already-bound account preserves its token while persisting a validated IDC redirect", async () => {
  auth.saveAccount("bound", { token: "existing-token", baseUrl: "https://ilinkai.weixin.qq.com" });
  fakeFetch([qr(), { status: "scaned_but_redirect", redirect_host: "ilinkhk.weixin.qq.com" }, { status: "binded_redirect", ilink_bot_id: "bound" }]);
  const result = await startAndWait();
  assert.equal(result.connected, true);
  assert.equal(result.baseUrl, "https://ilinkhk.weixin.qq.com");
  assert.equal(auth.loadAccount("bound").baseUrl, result.baseUrl);
  assert.equal(auth.loadAccount("bound").token, "existing-token");
});

test("already-bound status cannot succeed with absent, mismatched, or ambiguous credentials", async () => {
  fakeFetch([qr(), { status: "binded_redirect" }]);
  assert.equal((await startAndWait()).connected, false);
  auth.saveAccount("first", { token: "first-token" });
  auth.saveAccount("second", { token: "second-token" });
  for (const response of [{ status: "binded_redirect" }, { status: "binded_redirect", ilink_bot_id: "missing" }, { status: "binded_redirect", ilink_bot_id: "first", bot_token: "wrong-token" }]) {
    fakeFetch([qr(), response]);
    const result = await startAndWait();
    assert.equal(result.connected, false);
    assert.equal(result.alreadyConnected, undefined);
  }
});

test("already-bound response can identify the local account by token or requested account", async () => {
  auth.saveAccount("first", { token: "first-token" });
  auth.saveAccount("second", { token: "second-token" });
  fakeFetch([qr(), { status: "binded_redirect", bot_token: "first-token" }]);
  assert.equal((await startAndWait()).accountId, "first");
  fakeFetch([qr(), { status: "binded_redirect" }]);
  assert.equal((await startAndWait({ accountId: "second" })).accountId, "second");
});

test("login HTTP errors do not expose token, QR, or verification-code response text", async () => {
  const secret = "bot_token=token-secret&qrcode=qr-secret&verify_code=123456";
  fakeFetch([() => new Response(secret, { status: 403 })]);
  const start = await auth.startLogin();
  assert.equal(start.qrcodeUrl, undefined);
  assert.match(start.message, /403/);
  assert.doesNotMatch(start.message, /token-secret|qr-secret|123456/);
});

test("debug login logs omit local tokens, QR identifiers, and pairing codes", async () => {
  const { log } = await import("../src/util.mjs");
  const previousLevel = log._level;
  const previousEmit = log._emit;
  const logs = [];
  log._emit = (level, message, metadata) => logs.push(JSON.stringify({ level, message, metadata }));
  log.setLevel("debug");
  try {
    auth.saveAccount("prior", { token: "local-secret-token" });
    fakeFetch([qr("qr-secret-value"), { status: "need_verifycode" }, confirmed({ bot_token: "new-secret-token" })]);
    assert.equal((await startAndWait({ onVerifyCode: () => "987654" })).connected, true);
    assert.doesNotMatch(logs.join("\n"), /local-secret-token|qr-secret-value|new-secret-token|987654/);
  } finally {
    log._level = previousLevel;
    log._emit = previousEmit;
  }
});

test("pairing input callback respects cancellation without leaving a hung login", async () => {
  fakeFetch([qr(), { status: "need_verifycode" }]);
  const controller = new AbortController();
  const result = await startAndWait({
    signal: controller.signal,
    onVerifyCode: () => { controller.abort(); return new Promise(() => {}); },
  });
  assert.equal(result.connected, false);
  assert.match(result.message, /失败/);
});

test("transient poll network errors retry and can still complete login", async () => {
  fakeFetch([qr(), new TypeError("network disconnected qrcode=secret"), confirmed()]);
  const result = await startAndWait();
  assert.equal(result.connected, true);
});

test("persist:false returns credentials without creating an account", async () => {
  fakeFetch([qr(), confirmed()]);
  const result = await startAndWait({ persist: false });
  assert.equal(result.connected, true);
  assert.equal(result.token, "secret-bot-token");
  assert.deepEqual(auth.listAccountIds(), []);
});

test("legacy account and cursor files remain available after directory migration", async () => {
  const legacy = path.join(stateDir, "openclaw-weixin");
  fs.mkdirSync(path.join(legacy, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "accounts.json"), JSON.stringify(["legacy"]));
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.json"), JSON.stringify({ token: "legacy-token" }));
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.sync.json"), JSON.stringify({ get_updates_buf: "legacy-cursor" }));
  auth = await import(`../src/auth.mjs?auth-legacy=${++sequence}`);
  assert.equal(auth.loadAccount("legacy").token, "legacy-token");
  assert.equal(auth.loadSyncBuf("legacy"), "legacy-cursor");
  assert.equal(fs.existsSync(path.join(stateDir, "weixin-bot")), true);
});

test("fresh account credentials remain visible when quote storage initializes its canonical directory", async () => {
  const { QuoteStore, resolveQuoteCachePolicy, isQuoteCacheAvailable } = await import("../src/quote-store.mjs");
  const saved = auth.saveAccount("fresh", { token: "fresh-token" });
  assert.equal(fs.existsSync(path.join(stateDir, "weixin-bot", "accounts", "fresh.json")), true);
  assert.equal(fs.existsSync(path.join(stateDir, "openclaw-weixin")), false);
  const store = await QuoteStore.open({ policy: resolveQuoteCachePolicy({}) });
  if (isQuoteCacheAvailable()) assert.ok(store); else assert.equal(store, null);
  try {
    assert.deepEqual(auth.loadAccount("fresh"), saved);
    assert.equal(auth.resolveAccount({ accountId: "fresh" }).token, "fresh-token");
  } finally {
    store?.close();
  }
});

test("runtime state directory changes migrate legacy data after module initialization", () => {
  const legacy = path.join(stateDir, "openclaw-weixin");
  fs.mkdirSync(path.join(legacy, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "accounts.json"), '["legacy"]');
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.json"), '{"token":"legacy-token"}');
  assert.equal(auth.loadAccount("legacy").token, "legacy-token");
  assert.equal(fs.existsSync(path.join(stateDir, "weixin-bot", "accounts", "legacy.json")), true);
  assert.equal(fs.existsSync(legacy), false);
});

test("canonical and legacy directories preserve distinct accounts and prefer canonical credentials", () => {
  const canonical = path.join(stateDir, "weixin-bot");
  const legacy = path.join(stateDir, "openclaw-weixin");
  for (const directory of [canonical, legacy]) fs.mkdirSync(path.join(directory, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(canonical, "accounts.json"), '["canonical","shared"]');
  fs.writeFileSync(path.join(legacy, "accounts.json"), '["legacy","shared"]');
  fs.writeFileSync(path.join(canonical, "accounts", "canonical.json"), '{"token":"canonical-token"}');
  fs.writeFileSync(path.join(canonical, "accounts", "shared.json"), '{"token":"current-token"}');
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.json"), '{"token":"legacy-token","userId":"legacy-user"}');
  fs.writeFileSync(path.join(legacy, "accounts", "shared.json"), '{"token":"old-shared-token"}');
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.sync.json"), '{"get_updates_buf":"legacy-cursor"}');
  assert.deepEqual(new Set(auth.listAccountIds()), new Set(["canonical", "legacy", "shared"]));
  assert.equal(auth.loadAccount("legacy").token, "legacy-token");
  assert.equal(auth.loadSyncBuf("legacy"), "legacy-cursor");
  assert.equal(auth.loadAccount("shared").token, "current-token");
  auth.saveAccount("legacy", { baseUrl: "https://ilinkai.weixin.qq.com" });
  assert.equal(auth.loadAccount("legacy").token, "legacy-token");
  assert.equal(auth.loadAccount("legacy").userId, "legacy-user");
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, "accounts", "shared.json"))).token, "old-shared-token");
  assert.ok(JSON.parse(fs.readFileSync(path.join(canonical, "accounts.json"))).includes("legacy"));
  auth.deleteAccount("legacy");
  assert.equal(auth.loadAccount("legacy"), null);
  assert.equal(auth.loadSyncBuf("legacy"), undefined);
  assert.equal(auth.listAccountIds().includes("legacy"), false);
  assert.equal(auth.loadAccount("shared").token, "current-token");
});

test("failed legacy migration keeps credentials readable after canonical quote directory creation", () => {
  const legacy = path.join(stateDir, "openclaw-weixin");
  fs.mkdirSync(path.join(legacy, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "accounts.json"), '["legacy"]');
  fs.writeFileSync(path.join(legacy, "accounts", "legacy.json"), '{"token":"legacy-token"}');
  const renameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === legacy) {
      const error = new Error("migration temporarily unavailable");
      error.code = "EACCES";
      throw error;
    }
    return renameSync(source, destination);
  };
  try {
    assert.equal(auth.loadAccount("legacy").token, "legacy-token");
    fs.mkdirSync(path.join(stateDir, "weixin-bot"));
    assert.equal(auth.loadAccount("legacy").token, "legacy-token");
    assert.deepEqual(auth.listAccountIds(), ["legacy"]);
    auth.saveAccount("new", { token: "new-token" });
    assert.equal(auth.loadAccount("legacy").token, "legacy-token");
    assert.equal(auth.loadAccount("new").token, "new-token");
  } finally {
    fs.renameSync = renameSync;
  }
});
