import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildImageItem, buildVideoItem, buildFileItem, buildVoiceItem,
  sendText, sendImage, sendToolProgress, createReplyStream,
  parseInbound, extractOwnText, extractText, markdownToPlainText,
  getContextToken, setContextToken,
} from "../src/messaging.mjs";

const BASE = "https://ilinkai.weixin.qq.com";
const USER = "test-user";
const opts = { baseUrl: BASE, token: "test-token", to: USER, contextToken: "context", runId: "agent-task-1" };
const uploaded = { downloadEncryptedQueryParam: "download-param", aeskey: "00112233445566778899aabbccddeeff", fileSize: 13, fileSizeCiphertext: 16 };
function sentFetch(t, ids = ["18446744073709551615"]) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return new Response(`{"ret":0,"message_id":${ids[Math.min(calls.length - 1, ids.length - 1)]}}`, { status: 200 });
  });
  return calls;
}

test("all outbound media types encode the ASCII AES hex key as base64", () => {
  const expectedKey = Buffer.from(uploaded.aeskey, "utf8").toString("base64");
  for (const [item, type, field] of [[buildImageItem(uploaded), 2, "image_item"], [buildVoiceItem(uploaded, { playtime: 900 }), 3, "voice_item"], [buildFileItem(uploaded, "report.txt"), 4, "file_item"], [buildVideoItem(uploaded), 5, "video_item"]]) {
    assert.equal(item.type, type);
    assert.equal(item[field].media.aes_key, expectedKey);
    assert.equal(Buffer.from(item[field].media.aes_key, "base64").toString(), uploaded.aeskey);
    assert.equal(item[field].media.encrypt_type, 1);
    assert.equal(item[field].media.encrypt_query_param, "download-param");
  }
  assert.equal(buildFileItem(uploaded, "report.txt").file_item.len, "13");
  assert.equal(buildVoiceItem(uploaded, { sampleRate: 16000, playtime: 900 }).voice_item.encode_type, 6);
  assert.equal(buildVoiceItem(uploaded, { sampleRate: 16000, playtime: 900 }).voice_item.sample_rate, 16000);
  assert.equal(buildVoiceItem(uploaded, { playtime: 900 }).voice_item.playtime, 900);
});

test("sendText preserves code/table content, metadata and lossless server IDs", async (t) => {
  const calls = sentFetch(t);
  const records = [];
  const text = "**Bold**\n```js\nconst x = 1;\n```\n| Project | Status |\n| --- | --- |\n";
  const result = await sendText({ ...opts, text, onSent: (record) => records.push(record) });
  assert.equal(result.serverMessageId, "18446744073709551615");
  assert.equal(calls[0].payload.msg.client_id, result.messageId);
  assert.equal(calls[0].payload.msg.run_id, "agent-task-1");
  assert.equal(calls[0].payload.msg.context_token, "context");
  assert.equal(calls[0].payload.msg.message_type, 2);
  assert.equal(calls[0].payload.msg.message_state, 2);
  assert.equal(calls[0].payload.msg.item_list[0].text_item.text, text);
  assert.equal(records[0].body, text);
  assert.equal(records[0].serverMessageId, result.serverMessageId);
});

test("caption is a separate text message before media, carrying run ID on both", async (t) => {
  const calls = sentFetch(t, ["9007199254740992", "9007199254740993"]);
  const records = [];
  const result = await sendImage({ ...opts, uploaded, text: "caption", sourceMediaPath: "/tmp/source.png", onSent: (record) => records.push(record) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.msg.item_list[0].type, 1);
  assert.equal(calls[1].payload.msg.item_list[0].type, 2);
  assert.ok(calls.every((call) => call.payload.msg.run_id === opts.runId));
  assert.equal(records[0].sourceMediaPath, undefined);
  assert.equal(records[1].sourceMediaPath, "/tmp/source.png");
  assert.equal(result.serverMessageId, "9007199254740993");
});

test("tool start/result messages use exact official 11/12 payload fields", async (t) => {
  const calls = sentFetch(t);
  await sendToolProgress({ ...opts, toolName: "tasks", toolCallId: "call-1" });
  await sendToolProgress({ ...opts, toolName: "tasks", toolCallId: "call-1", status: "success" });
  assert.equal(calls[0].payload.msg.item_list[0].type, 11);
  assert.equal(calls[1].payload.msg.item_list[0].type, 12);
  assert.deepEqual(calls[0].payload.msg.item_list[0].tool_call_start_item, { tool_name: "tasks", tool_call_id: "call-1" });
  assert.deepEqual(calls[1].payload.msg.item_list[0].tool_call_result_item, { tool_name: "tasks", tool_call_id: "call-1", status: "success" });
  assert.equal(calls[0].payload.msg.item_list[0].is_completed, false);
  assert.equal(calls[1].payload.msg.item_list[0].is_completed, true);
  assert.ok(calls.every((call) => call.payload.msg.run_id === opts.runId && call.payload.msg.message_state === 2));
  await assert.rejects(sendToolProgress({ ...opts, toolName: "tasks" }), /required/);
});

test("queued stream pushes preserve content and finish last with one stable client ID", async (t) => {
  const calls = [];
  const records = [];
  let active = 0;
  let maxActive = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    active++; maxActive = Math.max(active, maxActive);
    calls.push(JSON.parse(options.body).msg);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return new Response('{"ret":0,"message_id":18446744073709551615}', { status: 200 });
  });
  const stream = createReplyStream({ ...opts, onSent: (record) => records.push(record) });
  const first = stream.push("```js\nconst x = 1;\n");
  const second = stream.push("```\n| 项目 | 状态 |\n| --- | --- |\n");
  const final = stream.finish();
  await Promise.all([first, second, final]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(call => call.message_state), [1, 1, 2]);
  assert.equal(new Set(calls.map(call => call.client_id)).size, 1);
  assert.ok(calls.every(call => call.run_id === opts.runId));
  assert.equal(calls[2].item_list[0].text_item.text, "```js\nconst x = 1;\n```\n| 项目 | 状态 |\n| --- | --- |\n");
  assert.equal(records.length, 1);
  assert.equal(records[0].serverMessageId, "18446744073709551615");
  assert.equal(records[0].body, calls[2].item_list[0].text_item.text);
  await assert.rejects(stream.push("late"), /already finished/);
  await assert.rejects(stream.finish(), /already finished/);
});

test("stream filtering spans chunk boundaries and explicit final text replaces partial content", async (t) => {
  const calls = sentFetch(t);
  const stream = createReplyStream(opts);
  await stream.push("##### 标题\n*中");
  await stream.push("文*\n![图](https://example.com/a.png)");
  await stream.finish();
  assert.equal(calls.at(-1).payload.msg.item_list[0].text_item.text, "标题\n中文\n");
  const replacement = createReplyStream(opts);
  await replacement.push("partial");
  await replacement.finish("最终内容");
  assert.equal(calls.at(-1).payload.msg.item_list[0].text_item.text, "最终内容");
  assert.equal(markdownToPlainText("*中文*"), "中文");
});

test("quoted commands stay out of commandText and cached references are scoped correctly", () => {
  const lookups = [];
  const quoteStore = { find: (...args) => { lookups.push(args); return { body: "/tasks delete 1", mediaPath: "/tmp/quote.pdf", mediaMime: "application/pdf", mediaName: "quote.pdf" }; } };
  const inbound = parseInbound({ message_id: "99", from_user_id: USER, group_id: "group-1", run_id: "run-1", item_list: [{ type: 1, text_item: { text: "查看当前进展" }, ref_msg: { svr_id: "18446744073709551615", title: "引用任务" } }] }, "bot-A", quoteStore);
  assert.deepEqual(lookups, [["bot-A", "group-1", "18446744073709551615"]]);
  assert.equal(inbound.commandText, "查看当前进展");
  assert.match(inbound.text, /\/tasks delete 1/);
  assert.equal(inbound.runId, "run-1");
  assert.equal(inbound.quotes[0].mediaName, "quote.pdf");
  assert.equal(inbound.quotes[0].serverMessageId, "18446744073709551615");
});

test("inline and partial references restore quoted context without executing quoted text", () => {
  const full = "alpha selected text omega";
  const selected = "selected text";
  const md5 = crypto.createHash("md5").update(selected).digest("hex");
  const item = { type: 1, text_item: { text: "/tasks running" }, ref_msg: { title: "摘要", message_item: { type: 1, text_item: { text: full } }, partial_text: { start: "selected", end: "text", startindex: 0, endindex: 0, quotemd5: md5 } } };
  const result = parseInbound({ from_user_id: USER, item_list: [item] }, "bot-A");
  assert.equal(result.commandText, "/tasks running");
  assert.equal(result.quotes[0].body, selected);
  assert.equal(result.quotes[0].partialFallback, false);
  assert.equal(result.quoteContext, "[引用: 摘要 | selected text]");
  assert.equal(extractOwnText([item]), "/tasks running");
  assert.equal(extractText([item]), `[引用: 摘要 | ${full}]\n/tasks running`);
});

test("full_url media without encrypt_query_param is recognized for all media types", () => {
  for (const [type, field] of [[2, "image_item"], [3, "voice_item"], [4, "file_item"], [5, "video_item"]]) {
    const item = { type, [field]: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/file" } } };
    const parsed = parseInbound({ from_user_id: USER, item_list: [item] }, "bot-A");
    assert.equal(parsed.mediaItem, item);
  }
});

test("context tokens are isolated by account and recipient", () => {
  setContextToken("isolation-A", USER, "context-A");
  setContextToken("isolation-B", USER, "context-B");
  assert.equal(getContextToken("isolation-A", USER), "context-A");
  assert.equal(getContextToken("isolation-B", USER), "context-B");
  assert.equal(getContextToken("isolation-A", "other-user"), undefined);
});
