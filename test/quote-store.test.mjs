import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuoteStore, resolveQuoteCachePolicy, resolveQuoteMediaSubdir, isQuoteCacheAvailable } from "../src/quote-store.mjs";
import { resolvePartialQuote } from "../src/partial-quote.mjs";
import { parseJsonLossless } from "../src/json.mjs";

const sqliteTest = (name, fn) => test(name, { skip: !isQuoteCacheAvailable() && "requires native SQLite" }, fn);

let temporary;
let rootDir;
let mediaRoot;
const stores = [];
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-test-"));
  rootDir = path.join(temporary, "state");
  mediaRoot = path.join(temporary, "media");
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function policy(extra = {}) {
  return { ...resolveQuoteCachePolicy({}), ...extra };
}
async function open(extra = {}) {
  const store = await QuoteStore.open({ rootDir, mediaRoot, policy: policy(extra) });
  assert.ok(store, "node:sqlite quote store should open on supported Node");
  stores.push(store);
  return store;
}
function message(extra = {}) {
  return { accountId: "bot-A", conversationId: "user-A", messageId: "9007199254740993", direction: "inbound", body: "quoted text", ...extra };
}
function media(accountId, name, contents = "image") {
  const directory = path.join(mediaRoot, path.posix.basename(resolveQuoteMediaSubdir(accountId)));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, contents);
  return file;
}
const md5 = (value) => crypto.createHash("md5").update(value, "utf8").digest("hex");

test("quote policy defaults are bounded and invalid numeric settings use defaults", () => {
  const defaults = resolveQuoteCachePolicy({});
  assert.deepEqual(resolveQuoteCachePolicy(), defaults);
  assert.deepEqual(resolveQuoteCachePolicy(null), defaults);
  const invalid = resolveQuoteCachePolicy({ channels: { "openclaw-weixin": { quoteCache: {
    retentionDays: -1, maxMessagesPerAccount: NaN, mediaRetentionDays: 0,
    maxMediaBytesPerAccount: Infinity, maxSingleMediaBytes: "huge",
  } } } });
  assert.deepEqual(invalid, defaults);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxMessagesPerAccount, 10_000);
  assert.equal(defaults.maxSingleMediaBytes, 25 * 1024 * 1024);
  const customized = resolveQuoteCachePolicy({ channels: { "openclaw-weixin": { quoteCache: { enabled: false, maxMessagesPerAccount: 2.9, retentionDays: 0.5 } } } });
  assert.equal(customized.enabled, false);
  assert.equal(customized.maxMessagesPerAccount, 2);
  assert.equal(customized.retentionMs, 12 * 60 * 60 * 1000);
});

test("disabled quote store creates no database or media directories", async () => {
  const store = await QuoteStore.open({ rootDir, mediaRoot, policy: policy({ enabled: false }) });
  assert.equal(store, null);
  assert.equal(fs.existsSync(rootDir), false);
  assert.equal(fs.existsSync(mediaRoot), false);
});

test("unavailable or disabled SQLite cache creates no directories and returns null", async () => {
  const store = await QuoteStore.open({ rootDir, mediaRoot, policy: policy({ enabled: !isQuoteCacheAvailable() }) });
  assert.equal(store, null);
  assert.equal(fs.existsSync(rootDir), false);
  assert.equal(fs.existsSync(mediaRoot), false);
});

test("unavailable or disabled cache leaves existing database and media untouched", async () => {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(mediaRoot, { recursive: true });
  const database = path.join(rootDir, "ref-messages.sqlite"), file = path.join(mediaRoot, "kept.png");
  fs.writeFileSync(database, "existing database");
  fs.writeFileSync(file, "existing media");
  assert.equal(await QuoteStore.open({ rootDir, mediaRoot, policy: policy({ enabled: !isQuoteCacheAvailable() }) }), null);
  assert.equal(fs.readFileSync(database, "utf8"), "existing database");
  assert.equal(fs.readFileSync(file, "utf8"), "existing media");
});

sqliteTest("same message ID is isolated by bot account and conversation", async () => {
  const store = await open();
  await store.put(message({ body: "account-A/user-A" }));
  await store.put(message({ accountId: "bot-B", body: "account-B/user-A" }));
  await store.put(message({ conversationId: "user-B", body: "account-A/user-B" }));
  assert.equal(store.find("bot-A", "user-A", "9007199254740993").body, "account-A/user-A");
  assert.equal(store.find("bot-B", "user-A", "9007199254740993").body, "account-B/user-A");
  assert.equal(store.find("bot-A", "user-B", "9007199254740993").body, "account-A/user-B");
  assert.equal(store.find("bot-B", "user-B", "9007199254740993"), null);
});

sqliteTest("adjacent unsafe uint64 message IDs survive JSON and SQLite without rounding", async () => {
  const store = await open();
  const parsed = parseJsonLossless('{"messages":[{"message_id":9007199254740992},{"message_id":9007199254740993},{"message_id":18446744073709551615}]}');
  const ids = ["9007199254740992", "9007199254740993", "18446744073709551615"];
  for (let i = 0; i < parsed.messages.length; i++) await store.put(message({ messageId: parsed.messages[i].message_id, body: `message-${i}` }));
  for (let i = 0; i < ids.length; i++) {
    const found = store.find("bot-A", "user-A", ids[i]);
    assert.equal(found.messageId, ids[i]);
    assert.equal(found.body, `message-${i}`);
  }
});

sqliteTest("quote cache persists across reopen with private database permissions", async () => {
  const original = await open();
  await original.put(message());
  original.close();
  const reopened = await open();
  assert.equal(reopened.find("bot-A", "user-A", "9007199254740993").body, "quoted text");
  assert.equal(fs.statSync(path.join(rootDir, "ref-messages.sqlite")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(rootDir).mode & 0o777, 0o700);
});

sqliteTest("message retention removes expired content and its orphaned managed media", async () => {
  const store = await open({ retentionMs: 1000 });
  const file = media("bot-A", "old.png");
  await store.put(message({ sourceMediaPath: file, createdAt: Date.now() - 2000 }));
  assert.equal(store.find("bot-A", "user-A", "9007199254740993"), null);
  assert.equal(fs.existsSync(file), false);
});

sqliteTest("garbage collection enforces message counts separately for each account", async () => {
  const store = await open({ maxMessagesPerAccount: 2 });
  const now = Date.now();
  for (const accountId of ["bot-A", "bot-B"]) {
    for (let i = 0; i < 4; i++) await store.put(message({ accountId, messageId: String(i), createdAt: now - 100 + i, body: `${accountId}-${i}` }));
  }
  store.runGc(now);
  for (const accountId of ["bot-A", "bot-B"]) {
    assert.equal(store.find(accountId, "user-A", "0"), null);
    assert.equal(store.find(accountId, "user-A", "1"), null);
    assert.ok(store.find(accountId, "user-A", "2"));
    assert.ok(store.find(accountId, "user-A", "3"));
  }
});

sqliteTest("media retention expires files while retaining referenced message text", async () => {
  const store = await open({ retentionMs: 10_000, mediaRetentionMs: 1000 });
  const now = Date.now();
  const file = media("bot-A", "old-media.png");
  await store.put(message({ sourceMediaPath: file, createdAt: now - 2000 }));
  store.runGc(now);
  const found = store.find("bot-A", "user-A", "9007199254740993");
  assert.equal(found.body, "quoted text");
  assert.equal(found.mediaPath, undefined);
  assert.equal(fs.existsSync(file), false);
});

sqliteTest("media budget evicts oldest unique files and retains message text", async () => {
  const store = await open({ maxMediaBytesPerAccount: 8, maxSingleMediaBytes: 8 });
  const files = [];
  for (let i = 0; i < 3; i++) {
    files.push(media("bot-A", `image-${i}.png`, "1234"));
    await store.put(message({ messageId: String(i), sourceMediaPath: files[i], createdAt: Date.now() - 1000 + i }));
  }
  assert.equal(fs.existsSync(files[0]), false);
  assert.equal(fs.existsSync(files[1]), true);
  assert.equal(fs.existsSync(files[2]), true);
  assert.equal(store.find("bot-A", "user-A", "0").body, "quoted text");
  assert.equal(store.find("bot-A", "user-A", "0").mediaPath, undefined);
  assert.equal(store.listMedia("bot-A").reduce((sum, item) => sum + item.media_size, 0), 8);
});

sqliteTest("duplicate references count media once and delete it only after the last reference", async () => {
  const store = await open({ maxMediaBytesPerAccount: 5 });
  const file = media("bot-A", "shared.png", "12345");
  await store.put(message({ messageId: "1", sourceMediaPath: file }));
  await store.put(message({ messageId: "2", sourceMediaPath: file }));
  assert.equal(store.listMedia("bot-A").length, 1);
  store.deleteMessage("bot-A", "user-A", "1");
  assert.equal(fs.existsSync(file), true);
  store.deleteMessage("bot-A", "user-A", "2");
  assert.equal(fs.existsSync(file), false);
});

sqliteTest("unmanaged, oversized, or symlink-escaped media is never registered", async () => {
  const store = await open({ maxSingleMediaBytes: 4 });
  const outside = path.join(temporary, "outside.png");
  fs.writeFileSync(outside, "abc");
  const large = media("bot-A", "oversized.png", "12345");
  const link = media("bot-A", "link.png", "");
  fs.unlinkSync(link);
  fs.symlinkSync(outside, link);
  for (const [i, sourceMediaPath] of [outside, large, link].entries()) {
    await store.put(message({ messageId: String(i), sourceMediaPath }));
    assert.equal(store.find("bot-A", "user-A", String(i)).mediaPath, undefined);
  }
  assert.equal(fs.existsSync(outside), true);
});

sqliteTest("updating message body preserves an existing media reference", async () => {
  const store = await open();
  const file = media("bot-A", "preserved.png");
  await store.put(message({ sourceMediaPath: file, mediaMime: "image/png" }));
  await store.put(message({ body: "updated text" }));
  const found = store.find("bot-A", "user-A", "9007199254740993");
  assert.equal(found.body, "updated text");
  assert.equal(found.mediaPath, file);
  assert.equal(found.mediaMime, "image/png");
});

sqliteTest("replacing a cached media file immediately removes its orphaned predecessor", async () => {
  const store = await open({ maxMediaBytesPerAccount: 5 });
  const previous = media("bot-A", "previous.png", "12345");
  const replacement = media("bot-A", "replacement.png", "67890");
  await store.put(message({ sourceMediaPath: previous }));
  await store.put(message({ sourceMediaPath: replacement }));
  assert.equal(fs.existsSync(previous), false);
  assert.equal(fs.existsSync(replacement), true);
  assert.equal(store.find("bot-A", "user-A", "9007199254740993").mediaPath, replacement);
});

sqliteTest("replacing a shared media file retains it while another message still references it", async () => {
  const store = await open();
  const previous = media("bot-A", "shared-old.png");
  const replacement = media("bot-A", "new.png");
  await store.put(message({ messageId: "1", sourceMediaPath: previous }));
  await store.put(message({ messageId: "2", sourceMediaPath: previous }));
  await store.put(message({ messageId: "1", sourceMediaPath: replacement }));
  assert.equal(fs.existsSync(previous), true);
  assert.equal(store.find("bot-A", "user-A", "2").mediaPath, previous);
});

sqliteTest("media-only quotes can omit body text", async () => {
  const store = await open();
  const file = media("bot-A", "media-only.png");
  await store.put(message({ body: undefined, sourceMediaPath: file }));
  const found = store.find("bot-A", "user-A", "9007199254740993");
  assert.equal(found.body, "");
  assert.equal(found.mediaPath, file);
});

sqliteTest("deleting one account retains another account's quotes and media", async () => {
  const store = await open();
  const fileA = media("bot-A", "image.png");
  const fileB = media("bot-B", "image.png");
  await store.put(message({ sourceMediaPath: fileA }));
  await store.put(message({ accountId: "bot-B", sourceMediaPath: fileB }));
  store.deleteAccount("bot-A");
  assert.equal(store.find("bot-A", "user-A", "9007199254740993"), null);
  assert.equal(fs.existsSync(fileA), false);
  assert.ok(store.find("bot-B", "user-A", "9007199254740993"));
  assert.equal(fs.existsSync(fileB), true);
});

test("account media paths remain distinct for colliding readable names", () => {
  const first = resolveQuoteMediaSubdir("../../BOT/@same");
  const second = resolveQuoteMediaSubdir("..//bot/@same");
  assert.notEqual(first, second);
  assert.equal(first.split("/").some((part) => part === ".."), false);
  assert.match(path.posix.basename(first), /^[a-z0-9._-]+-[a-f0-9]{16}$/);
});

sqliteTest("GC removes unreferenced managed media without touching external files", async () => {
  const store = await open();
  const orphan = media("bot-A", "orphan.png");
  const outside = path.join(temporary, "outside.png");
  fs.writeFileSync(outside, "keep");
  store.runGc();
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

test("partial quotes use zero-based global occurrences without a hash", () => {
  assert.deepEqual(resolvePartialQuote("s-0-e / s-1-e / s-2-e", { start: "s-", startindex: 1, end: "e", endindex: 1 }), { resolved: "s-1-e", fallback: false });
});

test("partial quote MD5 disambiguates global and relative endpoint interpretations", () => {
  const full = "s-0-e / s-1-e / s-2-e";
  const partial = { start: "s-", startindex: 1, end: "e", endindex: 1 };
  assert.equal(resolvePartialQuote(full, { ...partial, quotemd5: md5("s-1-e") }).resolved, "s-1-e");
  assert.equal(resolvePartialQuote(full, { ...partial, quotemd5: md5("s-1-e / s-2-e").toUpperCase() }).resolved, "s-1-e / s-2-e");
});

test("partial quote hashing includes Unicode bytes and newline boundaries", () => {
  const selected = "开始\n微信进展：已完成 ✓\n结束";
  const partial = { start: "开始", startindex: 0, end: "结束", endindex: 0, quotemd5: md5(selected) };
  assert.deepEqual(resolvePartialQuote(`前文 ${selected} 后文`, partial), { resolved: selected, fallback: false });
});

test("invalid partial boundaries or incorrect hashes return an explicit fallback", () => {
  const base = { start: "start", startindex: 0, end: "end", endindex: 0 };
  for (const partial of [{ ...base, startindex: -1 }, { ...base, endindex: 9 }, { ...base, start: "missing" }, { ...base, quotemd5: "wrong" }, { ...base, startindex: 0.5 }]) {
    assert.deepEqual(resolvePartialQuote("start end", partial), { resolved: null, fallback: true });
  }
  assert.deepEqual(resolvePartialQuote("end start", base), { resolved: null, fallback: true });
});

test("malformed partial quote payloads fall back without throwing", () => {
  const base = { start: "start", startindex: 0, end: "end", endindex: 0 };
  for (const partial of [undefined, null, {}, [], 5, "partial", { ...base, start: 1 }, { ...base, end: {} }, { ...base, startindex: "0" }, { ...base, endindex: Infinity }, { ...base, quotemd5: 12345 }, { ...base, quotemd5: null }]) {
    assert.deepEqual(resolvePartialQuote("start end", partial), { resolved: null, fallback: true });
  }
  assert.deepEqual(resolvePartialQuote(12345, base), { resolved: null, fallback: true });
});
