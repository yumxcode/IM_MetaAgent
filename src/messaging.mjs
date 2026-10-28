/**
 * 消息模块：出站发送 + 入站解析
 *
 * 出站（发送）：
 *  - sendText: 纯文本
 *  - sendMedia: 本地/远程文件，按 MIME 自动路由（image/video/file）
 *  - sendImageFile / sendVideoFile / sendFileAttachment: 显式类型
 *  - streamText: 流式回复（GENERATING → FINISH），支持边生成边推送
 *
 * 入站（解析）：
 *  - parseInbound: 将原始 WeixinMessage 解析为统一的结构化消息
 *  - extractText: 从 item_list 提取纯文本
 *  - contextToken 存储：accountId+userId → token（出站回复时回填）
 *
 * 与官方插件的 messaging 模块行为对齐。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { MessageItemType, MessageState, MessageType } from "./constants.mjs";
import { sendMessage as sendMessageApi } from "./http.mjs";
import {
  downloadRemoteUrlToTemp,
  uploadLocalFile,
  UploadedFileInfo,
  uploadVoice,
} from "./media.mjs";
import { StreamingMarkdownFilter } from "./markdown-filter.mjs";
import { resolvePartialQuote } from "./partial-quote.mjs";
import { log, generateId, isLocalFilePath, isRemoteUrl, resolveLocalPath } from "./util.mjs";

// ---------------------------------------------------------------------------
// contextToken 存储（进程级，accountId+userId → token）
// ---------------------------------------------------------------------------

const contextTokenStore = new Map();
function ctxKey(accountId, userId) { return JSON.stringify([accountId, userId]); }
export function clearContextTokens(accountId) {
  for (const key of contextTokenStore.keys()) if (JSON.parse(key)[0] === accountId) contextTokenStore.delete(key);
}

/** 存储某 account+user 的 contextToken（入站时记录，出站时取用）。 */
export function setContextToken(accountId, userId, token) {
  if (token) contextTokenStore.set(ctxKey(accountId, userId), token);
}

/** 取回某 account+user 的 contextToken。 */
export function getContextToken(accountId, userId) {
  return contextTokenStore.get(ctxKey(accountId, userId));
}

// ---------------------------------------------------------------------------
// Markdown → 纯文本（微信不支持 markdown 渲染）
// ---------------------------------------------------------------------------

/**
 * 将 markdown 格式的回复转为纯文本。
 * 与官方插件的 markdownToPlainText 行为一致。
 */
export function markdownToPlainText(text) {
  const filter = new StreamingMarkdownFilter();
  return filter.feed(String(text ?? "")) + filter.flush();
}

// ---------------------------------------------------------------------------
// 消息体构建
// ---------------------------------------------------------------------------

function genClientId() { return generateId("weixin-bot"); }

/**
 * 构建一个 SendMessage 请求体。
 * @param {object} p
 * @param {string} p.to - to_user_id（微信用户 ID）
 * @param {Array} p.itemList - MessageItem 数组
 * @param {string} [p.contextToken]
 * @param {number} [p.messageState=FINISH]
 */
function buildMessageReq({ to, itemList, contextToken, runId, clientId, messageState = MessageState.FINISH }) {
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId || genClientId(),
      run_id: runId || undefined,
      message_type: MessageType.BOT,
      message_state: messageState,
      item_list: itemList.length ? itemList : undefined,
      context_token: contextToken || undefined,
    },
  };
}

function textItem(text) {
  return { type: MessageItemType.TEXT, text_item: { text } };
}

// ---------------------------------------------------------------------------
// 出站：纯文本
// ---------------------------------------------------------------------------

/**
 * 发送纯文本消息。
 * contextToken 是必填项（无 token 则消息无法关联到对话）。
 *
 * @returns {Promise<{messageId:string}>} messageId（即 client_id）
 */
export async function sendText(opts = {}) {
  const { baseUrl, token, to, text, contextToken, timeoutMs, routeTag, runId, signal, onSent, clientId } = opts;
  if (!contextToken) log.warn("sendText: no contextToken", { to });
  const plain = markdownToPlainText(text);
  const req = buildMessageReq({ to, itemList: plain ? [textItem(plain)] : [], contextToken, runId, clientId });
  const resp = await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag, signal });
  const result = { messageId: req.msg.client_id, serverMessageId: resp?.message_id };
  await onSent?.({ ...result, body: plain });
  return result;
}

// ---------------------------------------------------------------------------
// 出站：媒体（按 MIME 自动路由）
// ---------------------------------------------------------------------------

/**
 * 发送一个媒体 item（可选附加文本 caption）。
 * caption 作为独立的 TEXT item 在媒体 item 之前发送。
 */
async function sendMediaItem(opts) {
  const { baseUrl, token, to, text, mediaItem, contextToken, timeoutMs, routeTag, runId, signal, onSent, sourceMediaPath } = opts;
  if (!contextToken) log.warn("sendMedia: no contextToken", { to });
  let result;
  if (text) await sendText({ ...opts, onSent: async record => onSent?.({ ...record, sourceMediaPath: undefined }) });
  const req = buildMessageReq({ to, itemList: [mediaItem], contextToken, runId });
  const resp = await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag, signal });
  result = { messageId: req.msg.client_id, serverMessageId: resp?.message_id };
  await onSent?.({ ...result, body: mediaItem.voice_item?.text || text || "", sourceMediaPath, mediaName: mediaItem.file_item?.file_name });
  return result;
}

/** 用已上传的文件信息构造图片 item。 */
export function buildImageItem(uploaded) {
  return {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** 用已上传的文件信息构造视频 item。 */
export function buildVideoItem(uploaded) {
  return {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** 用已上传的文件信息构造文件附件 item。 */
export function buildFileItem(uploaded, fileName) {
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

/**
 * 用已上传的文件信息发送图片。
 * @param {UploadedFileInfo} uploaded
 */
export function sendImage(opts = {}) {
  return sendMediaItem({ ...opts, mediaItem: buildImageItem(opts.uploaded) });
}
export function sendVideo(opts = {}) {
  return sendMediaItem({ ...opts, mediaItem: buildVideoItem(opts.uploaded) });
}
export function sendFile(opts = {}) {
  return sendMediaItem({ ...opts, mediaItem: buildFileItem(opts.uploaded, opts.fileName) });
}
export function buildVoiceItem(uploaded, opts = {}) {
  return { type: MessageItemType.VOICE, voice_item: {
    media: { encrypt_query_param: uploaded.downloadEncryptedQueryParam, aes_key: Buffer.from(uploaded.aeskey).toString("base64"), encrypt_type: 1 },
    encode_type: 6, sample_rate: opts.sampleRate || 24000,
    ...(opts.playtime !== undefined ? { playtime: opts.playtime } : {}),
  } };
}
export function sendVoice(opts = {}) {
  return sendMediaItem({ ...opts, mediaItem: buildVoiceItem(opts.uploaded, opts) });
}
export async function sendToolProgress(opts = {}) {
  const { toolName, toolCallId, status, ...rest } = opts;
  if (!toolName || !toolCallId) throw new Error("toolName and toolCallId are required");
  const item = status === undefined
    ? { type: MessageItemType.TOOL_CALL_START, tool_call_start_item: { tool_name: toolName, tool_call_id: toolCallId } }
    : { type: MessageItemType.TOOL_CALL_RESULT, tool_call_result_item: { tool_name: toolName, tool_call_id: toolCallId, status } };
  item.create_time_ms = Date.now(); item.is_completed = status !== undefined;
  const req = buildMessageReq({ ...rest, itemList: [item] });
  const resp = await sendMessageApi({ ...rest, msg: req.msg });
  return { messageId: req.msg.client_id, serverMessageId: resp?.message_id };
}

export async function sendMedia(opts) {
  const { mediaUrl, to, destDir, signal, timeoutMs } = opts;
  let filePath, remote = false;
  if (isLocalFilePath(mediaUrl)) filePath = resolveLocalPath(mediaUrl);
  else if (isRemoteUrl(mediaUrl)) {
    const dest = destDir || path.join(await getDefaultMediaTempDir(), "outbound");
    filePath = await downloadRemoteUrlToTemp(mediaUrl, dest, { signal, timeoutMs }); remote = true;
  } else throw new Error("sendMedia: unsupported mediaUrl scheme");
  try {
  const uploadOpts = { baseUrl: opts.baseUrl, token: opts.token, routeTag: opts.routeTag, timeoutMs, signal };
  const args = { filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl: opts.cdnBaseUrl };
  const mime = (await import("./mime.mjs")).getMimeFromFilename(filePath);
  const media = await import("./media.mjs");
  const common = { ...opts, sourceMediaPath: filePath };
  if (mime.startsWith("video/")) return await sendVideo({ ...common, uploaded: await media.uploadVideo(args) });
  if (mime.startsWith("image/")) return await sendImage({ ...common, uploaded: await media.uploadImage(args) });
  if (mime === "audio/silk") return await sendVoice({ ...common, uploaded: await uploadVoice(args) });
  return await sendFile({ ...common, fileName: path.basename(filePath), uploaded: await media.uploadFileAttachment(args) });
  } finally { if (remote) await fs.unlink(filePath).catch(() => {}); }
}

async function getDefaultMediaTempDir() {
  const os = await import("node:os");
  return path.join(os.tmpdir(), "weixin-bot", "media");
}

// ---------------------------------------------------------------------------
// 出站：流式回复（GENERATING → FINISH）
// ---------------------------------------------------------------------------

/**
 * 创建一个流式回复会话，用于边生成边推送（模拟 ChatGPT 打字效果）。
 *
 * 用法：
 *   const stream = bot.createReplyStream({ to, contextToken });
 *   await stream.push("第一段");        // message_state = GENERATING
 *   await stream.push("第二段");
 *   await stream.finish("完整回复");    // message_state = FINISH（最终内容）
 *
 * 注意：微信协议要求 FINISH 消息包含完整文本（不是增量）。
 *
 * @returns {{push:(text:string)=>Promise<void>, finish:(fullText:string)=>Promise<void>}}
 */
export function createReplyStream(opts = {}) {
  let fullText = "", plain = "", finished = false, chain = Promise.resolve();
  const filter = new StreamingMarkdownFilter();
  const clientId = genClientId();
  function enqueue(fn) { const next = chain.then(fn); chain = next.catch(() => {}); return next; }
  async function send(value, state) {
    const req = buildMessageReq({ ...opts, clientId, itemList: value ? [textItem(value)] : [], messageState: state });
    const resp = await sendMessageApi({ ...opts, msg: req.msg });
    const result = { messageId: clientId, serverMessageId: resp?.message_id };
    if (state === MessageState.FINISH) await opts.onSent?.({ ...result, body: value });
    return result;
  }
  return {
    push(chunk) {
      if (finished) return Promise.reject(new Error("stream already finished"));
      return enqueue(async () => { fullText += String(chunk); plain += filter.feed(String(chunk)); return send(plain, MessageState.GENERATING); });
    },
    finish(finalText) {
      if (finished) return Promise.reject(new Error("stream already finished"));
      finished = true;
      return enqueue(() => send(finalText === undefined ? plain + filter.flush() : markdownToPlainText(finalText), MessageState.FINISH));
    },
  };
}

// ---------------------------------------------------------------------------
// 入站：消息解析
// ---------------------------------------------------------------------------

/**
 * 判断 item 是否为媒体类型。
 */
export function isMediaItem(item) {
  return (
    item?.type === MessageItemType.IMAGE ||
    item?.type === MessageItemType.VIDEO ||
    item?.type === MessageItemType.FILE ||
    item?.type === MessageItemType.VOICE
  );
}

/**
 * 从 item_list 提取纯文本内容。
 * 处理：文本、引用消息、语音转文字。
 */
export function extractOwnText(itemList = []) {
  return itemList.map(item => item.text_item?.text ?? item.voice_item?.text ?? "").filter(Boolean).join("\n");
}
export function extractText(itemList = []) {
  const own = extractOwnText(itemList);
  const quotes = itemList.flatMap(item => {
    const ref = item.ref_msg;
    if (!ref) return [];
    const body = ref.message_item ? extractOwnText([ref.message_item]) : "";
    return [ref.title, body].filter(Boolean).join(" | ") || [];
  });
  return [...quotes.map(body => '[引用: ' + body + ']'), own].filter(Boolean).join("\n");
}
export function parseInbound(msg, accountId, quoteStore) {
  const commandText = extractOwnText(msg.item_list);
  const conversationId = msg.group_id || msg.from_user_id || "";
  const quotes = [];
  let quotedMedia;
  for (const item of msg.item_list ?? []) {
    const ref = item.ref_msg;
    if (!ref) continue;
    const cached = ref.svr_id ? quoteStore?.find(accountId, conversationId, String(ref.svr_id)) : undefined;
    let body = ref.message_item ? extractOwnText([ref.message_item]) : cached?.body;
    let partialFallback = false;
    if (body && ref.partial_text) {
      const partial = resolvePartialQuote(body, ref.partial_text);
      body = partial.resolved || body; partialFallback = partial.fallback;
    }
    quotes.push({ title: ref.title, body: body || "", serverMessageId: ref.svr_id, partialFallback, mediaPath: cached?.mediaPath, mediaMime: cached?.mediaMime, mediaName: cached?.mediaName });
    if (isMediaItem(ref.message_item)) quotedMedia = ref.message_item;
  }
  const quoteContext = quotes.map(q => [q.title, q.body].filter(Boolean).join(" | ")).filter(Boolean).map(body => '[引用: ' + body + ']').join("\n");
  return { raw: msg, accountId, fromUserId: msg.from_user_id ?? "", toUserId: msg.to_user_id ?? "",
    contextToken: msg.context_token, messageId: msg.message_id, seq: msg.seq, createTimeMs: msg.create_time_ms,
    sessionId: msg.session_id, groupId: msg.group_id, runId: msg.run_id,
    messageType: msg.message_type, messageState: msg.message_state,
    commandText, quoteContext, quotes, text: [quoteContext, commandText].filter(Boolean).join("\n"),
    mediaItem: findFirstMediaItem(msg.item_list) || quotedMedia || null,
    itemTypes: (msg.item_list ?? []).map(i => i.type),
  };
}
function findFirstMediaItem(itemList = []) {
  return [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE]
    .map(type => itemList.find(item => item.type === type && [item.image_item, item.video_item, item.file_item, item.voice_item].some(value => value?.media?.encrypt_query_param || value?.media?.full_url)))
    .find(Boolean) || null;
}
