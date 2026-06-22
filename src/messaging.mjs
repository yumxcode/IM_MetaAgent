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

import { MessageItemType, MessageState, MessageType } from "./constants.mjs";
import { sendMessage as sendMessageApi } from "./http.mjs";
import {
  downloadRemoteUrlToTemp,
  uploadLocalFile,
  UploadedFileInfo,
} from "./media.mjs";
import { log, generateId, isLocalFilePath, isRemoteUrl, resolveLocalPath } from "./util.mjs";

// ---------------------------------------------------------------------------
// contextToken 存储（进程级，accountId+userId → token）
// ---------------------------------------------------------------------------

const contextTokenStore = new Map();
function ctxKey(accountId, userId) { return `${accountId}:${userId}`; }

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
  if (!text) return "";
  let r = text;
  // 代码块：去围栏，保留代码内容
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  // 图片：整体移除
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 链接：仅保留显示文本
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // 表格：去分隔行，竖线转空格
  r = r.replace(/^\|[\s:|-]+\|$/gm, "");
  r = r.replace(/^\|(.+)\|$/gm, (_, inner) =>
    inner.split("|").map((c) => c.trim()).join("  "));
  // 去掉剩余行内 markdown 语法
  r = r.replace(/\*\*([^*]+)\*\*/g, "$1"); // 粗体
  r = r.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2"); // 斜体
  r = r.replace(/`([^`]+)`/g, "$1"); // 行内代码
  r = r.replace(/^#{1,6}\s+/gm, ""); // 标题
  r = r.replace(/^>\s?/gm, ""); // 引用
  r = r.replace(/^[-*+]\s+/gm, "- "); // 列表统一
  return r.trim();
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
function buildMessageReq({ to, itemList, contextToken, messageState = MessageState.FINISH }) {
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: genClientId(),
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
export async function sendText({ baseUrl, token, to, text, contextToken, timeoutMs, routeTag } = {}) {
  if (!contextToken) {
    throw new Error(`sendText: contextToken is required (to=${to})`);
  }
  const plain = markdownToPlainText(String(text ?? ""));
  const req = buildMessageReq({ to, itemList: plain ? [textItem(plain)] : [], contextToken });
  try {
    await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag });
  } catch (err) {
    log.error(`sendText failed`, { to, err: String(err) });
    throw err;
  }
  return { messageId: req.msg.client_id };
}

// ---------------------------------------------------------------------------
// 出站：媒体（按 MIME 自动路由）
// ---------------------------------------------------------------------------

/**
 * 发送一个媒体 item（可选附加文本 caption）。
 * caption 作为独立的 TEXT item 在媒体 item 之前发送。
 */
async function sendMediaItem({ baseUrl, token, to, text, mediaItem, contextToken, timeoutMs, routeTag, label }) {
  if (!contextToken) {
    throw new Error(`${label}: contextToken is required (to=${to})`);
  }
  const items = [];
  if (text) items.push(textItem(markdownToPlainText(text)));
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = genClientId();
    const req = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: contextToken || undefined,
      },
    };
    try {
      await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag });
    } catch (err) {
      log.error(`${label} failed`, { to, err: String(err) });
      throw err;
    }
  }
  return { messageId: lastClientId };
}

/** 用已上传的文件信息构造图片 item。 */
export function buildImageItem(uploaded) {
  return {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
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
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
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
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
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
export function sendImage({ baseUrl, token, to, text, uploaded, contextToken, timeoutMs, routeTag } = {}) {
  return sendMediaItem({
    baseUrl, token, to, text, mediaItem: buildImageItem(uploaded),
    contextToken, timeoutMs, routeTag, label: "sendImage",
  });
}

/** 用已上传的文件信息发送视频。 */
export function sendVideo({ baseUrl, token, to, text, uploaded, contextToken, timeoutMs, routeTag } = {}) {
  return sendMediaItem({
    baseUrl, token, to, text, mediaItem: buildVideoItem(uploaded),
    contextToken, timeoutMs, routeTag, label: "sendVideo",
  });
}

/** 用已上传的文件信息发送文件附件。 */
export function sendFile({ baseUrl, token, to, text, fileName, uploaded, contextToken, timeoutMs, routeTag } = {}) {
  return sendMediaItem({
    baseUrl, token, to, text, mediaItem: buildFileItem(uploaded, fileName),
    contextToken, timeoutMs, routeTag, label: "sendFile",
  });
}

/**
 * 高层 API：发送本地或远程媒体文件，自动按 MIME 路由。
 *
 * mediaUrl 支持：
 *  - 本地绝对/相对路径：/tmp/a.png, ./pic.jpg
 *  - file:// URL
 *  - http(s):// URL（先下载到本地临时目录）
 *
 * @param {object} opts
 * @param {string} opts.mediaUrl
 * @param {string} [opts.destDir] - 远程文件下载临时目录，默认 os.tmpdir()/weixin-bot/media/outbound
 */
export async function sendMedia(opts) {
  const { baseUrl, token, to, text, mediaUrl, contextToken, timeoutMs, routeTag, destDir } = opts;
  if (!contextToken) {
    throw new Error(`sendMedia: contextToken is required (to=${to})`);
  }
  let filePath;
  if (isLocalFilePath(mediaUrl)) {
    filePath = resolveLocalPath(mediaUrl);
    log.debug(`sendMedia: local file`, { filePath });
  } else if (isRemoteUrl(mediaUrl)) {
    const dest = destDir || path.join(await getDefaultMediaTempDir(), "outbound");
    filePath = await downloadRemoteUrlToTemp(mediaUrl, dest);
    log.debug(`sendMedia: remote downloaded`, { filePath });
  } else {
    throw new Error(`sendMedia: unsupported mediaUrl scheme: ${mediaUrl.slice(0, 80)}`);
  }

  const uploadOpts = { baseUrl, token, routeTag };
  const cdnBaseUrl = opts.cdnBaseUrl || "https://novac2c.cdn.weixin.qq.com/c2c";
  const mime = (await import("./mime.mjs")).getMimeFromFilename(filePath);

  if (mime.startsWith("video/")) {
    const { uploadVideo } = await import("./media.mjs");
    const uploaded = await uploadVideo({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendVideo({ baseUrl, token, to, text, uploaded, contextToken, timeoutMs, routeTag });
  }
  if (mime.startsWith("image/")) {
    const { uploadImage } = await import("./media.mjs");
    const uploaded = await uploadImage({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendImage({ baseUrl, token, to, text, uploaded, contextToken, timeoutMs, routeTag });
  }
  const { uploadFileAttachment } = await import("./media.mjs");
  const uploaded = await uploadFileAttachment({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
  return sendFile({ baseUrl, token, to, text, fileName: path.basename(filePath), uploaded, contextToken, timeoutMs, routeTag });
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
export function createReplyStream({ baseUrl, token, to, contextToken, timeoutMs, routeTag } = {}) {
  if (!contextToken) {
    throw new Error(`createReplyStream: contextToken is required (to=${to})`);
  }
  let fullText = "";
  return {
    async push(chunk) {
      fullText += chunk;
      const req = buildMessageReq({
        to,
        itemList: [textItem(markdownToPlainText(fullText))],
        contextToken,
        messageState: MessageState.GENERATING,
      });
      await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag });
    },
    async finish(finalText) {
      const text = finalText !== undefined ? finalText : fullText;
      const req = buildMessageReq({
        to,
        itemList: text ? [textItem(markdownToPlainText(text))] : [],
        contextToken,
        messageState: MessageState.FINISH,
      });
      await sendMessageApi({ baseUrl, token, msg: req.msg, timeoutMs, routeTag });
      return { messageId: req.msg.client_id };
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
export function extractText(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // 引用媒体：仅返回当前文本
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      // 引用文本：拼接引用上下文
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractText([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/**
 * 将原始 WeixinMessage 解析为统一的结构化入站消息。
 *
 * @returns {InboundMessage}
 */
export function parseInbound(msg, accountId) {
  const text = extractText(msg.item_list);
  const result = {
    raw: msg,
    accountId,
    fromUserId: msg.from_user_id ?? "",
    toUserId: msg.to_user_id ?? "",
    contextToken: msg.context_token,
    messageId: msg.message_id,
    seq: msg.seq,
    createTimeMs: msg.create_time_ms,
    sessionId: msg.session_id,
    groupId: msg.group_id,
    messageType: msg.message_type,
    messageState: msg.message_state,
    text,
    /** 入站媒体 item（首个媒体项，优先级 IMAGE > VIDEO > FILE > VOICE） */
    mediaItem: findFirstMediaItem(msg.item_list),
    /** 所有 item 的类型列表 */
    itemTypes: (msg.item_list ?? []).map((i) => i.type),
  };
  return result;
}

function findFirstMediaItem(itemList) {
  if (!itemList?.length) return null;
  const byType = (type) => itemList.find((i) => i.type === type && i.image_item?.media?.encrypt_query_param
    || i.type === type && i.video_item?.media?.encrypt_query_param
    || i.type === type && i.file_item?.media?.encrypt_query_param
    || i.type === type && i.voice_item?.media?.encrypt_query_param);
  return byType(MessageItemType.IMAGE)
    ?? byType(MessageItemType.VIDEO)
    ?? byType(MessageItemType.FILE)
    ?? byType(MessageItemType.VOICE)
    ?? null;
}
