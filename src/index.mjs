/**
 * WeixinBot —— 完备的微信 iLink Bot 接入层主类
 *
 * 设计目标：
 *  - 零框架依赖（仅依赖 Node.js >= 18 的内置 fetch / crypto）
 *  - 事件驱动：bot.on('message' | 'media' | 'image' | 'voice' | 'file' | 'video' | 'error' | 'session-expired')
 *  - Promise 化：bot.sendText(...), bot.sendMedia(...)
 *  - 多账号：login(accountId?) / start(accountId?) / 多账号并存
 *  - 健壮性：游标持久化、session-guard、退避重试、自动重连
 *
 * 用法：
 *   import { WeixinBot } from "./src/index.mjs";
 *   const bot = new WeixinBot();
 *   await bot.login();              // 扫码登录
 *   bot.on("message", async (msg) => {
 *     await bot.sendText({ to: msg.fromUserId, text: `你说: ${msg.text}`, contextToken: msg.contextToken });
 *   });
 *   await bot.start();              // 开始长轮询（阻塞）
 */
import os from "node:os";
import path from "node:path";

import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
  MessageItemType,
  MessageType,
} from "./constants.mjs";
import { WeixinApiError } from "./http.mjs";
import {
  login as authLogin,
  resolveAccount,
  loadAccount,
  loadSyncBuf,
  saveSyncBuf,
  listAccountIds,
  deleteAccount,
  startLogin,
  waitForLogin,
  renderQrCode,
} from "./auth.mjs";
import {
  sendText as _sendText,
  sendMedia as _sendMedia,
  sendImage as _sendImage,
  sendVideo as _sendVideo,
  sendFile as _sendFile,
  createReplyStream as _createReplyStream,
  parseInbound,
  extractText,
  isMediaItem,
  setContextToken,
  getContextToken,
} from "./messaging.mjs";
import { uploadLocalFile, downloadAndDecryptBuffer, saveBufferToFile } from "./media.mjs";
import { TypingTicketManager, createTypingController } from "./typing.mjs";
import { startPolling } from "./poller.mjs";
import { isSessionPaused, assertSessionActive } from "./session-guard.mjs";
import { log, generateId } from "./util.mjs";

/**
 * 轻量级事件分发器（避免依赖 events 模块的复杂 API）。
 * 支持多监听器、once、off。
 */
function createEmitter() {
  const listeners = new Map(); // event -> Set<fn>
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => this.off(event, fn);
    },
    once(event, fn) {
      const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
      return this.on(event, wrapper);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    async emit(event, ...args) {
      const fns = listeners.get(event);
      if (!fns?.size) return;
      // 复制一份，避免迭代中增删
      for (const fn of [...fns]) {
        try {
          await fn(...args);
        } catch (err) {
          log.error(`event listener error [${event}]`, { err: String(err) });
        }
      }
    },
    removeAllListeners(event) {
      if (event) listeners.delete(event);
      else listeners.clear();
    },
  };
}

/**
 * 默认入站媒体保存目录。
 */
function defaultInboundMediaDir() {
  return path.join(os.tmpdir(), "weixin-bot", "media", "inbound");
}

class WeixinBot {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl] - iLink API 基础地址
   * @param {string} [opts.cdnBaseUrl] - CDN 基础地址
   * @param {string} [opts.routeTag] - SKRouteTag（企业路由）
   * @param {string} [opts.inboundMediaDir] - 入站媒体保存目录
   * @param {boolean} [opts.autoDownloadMedia=true] - 是否自动下载入站媒体
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    this.cdnBaseUrl = opts.cdnBaseUrl || CDN_BASE_URL;
    this.routeTag = opts.routeTag;
    this.inboundMediaDir = opts.inboundMediaDir || defaultInboundMediaDir();
    this.autoDownloadMedia = opts.autoDownloadMedia !== false;

    this._emitter = createEmitter();
    this._typingManagers = new Map(); // accountId -> TypingTicketManager
    this._pollingAbort = null;
    this._defaultAccountId = null;
  }

  // ------------------------------------------------------------------
  // 事件订阅
  // ------------------------------------------------------------------

  /**
   * 订阅事件。支持的事件：
   *  - message: (msg: InboundMessage) => 收到任意用户消息
   *  - text: (msg) => 收到纯文本消息
   *  - image / voice / file / video: (msg) => 收到对应媒体消息（已下载）
   *  - media: (msg) => 收到任意媒体消息（已下载，mediaPath 字段填充）
   *  - error: (err) => 轮询或处理错误
   *  - session-expired: (accountId) => 会话过期
   *  - raw: (WeixinMessage, accountId) => 原始消息（最早触发，未经解析）
   */
  on(event, fn) { return this._emitter.on(event, fn); }
  once(event, fn) { return this._emitter.once(event, fn); }
  off(event, fn) { return this._emitter.off(event, fn); }
  /** 移除某事件的所有监听器；不传 event 则清空全部。 */
  removeAllListeners(event) { this._emitter.removeAllListeners(event); }

  // ------------------------------------------------------------------
  // 账号管理
  // ------------------------------------------------------------------

  /** 列出所有已登录账号 ID。 */
  listAccounts() { return listAccountIds(); }

  /** 设置默认账号（用于无 accountId 参数时的 API 调用）。 */
  setDefaultAccount(accountId) { this._defaultAccountId = accountId; }

  /** 获取默认账号（首个已登录账号或显式设置值）。 */
  getDefaultAccount() {
    return this._defaultAccountId ?? this.listAccounts()[0];
  }

  /**
   * 解析账号为运行时配置（合并存储的 token + 构造参数）。
   */
  _account(accountId) {
    const id = accountId || this.getDefaultAccount();
    if (!id) {
      throw new Error("no account: please login first or pass accountId");
    }
    return resolveAccount({
      accountId: id,
      baseUrl: this.baseUrl,
      cdnBaseUrl: this.cdnBaseUrl,
    });
  }

  // ------------------------------------------------------------------
  // 登录
  // ------------------------------------------------------------------

  /**
   * 扫码登录。成功后凭据自动持久化。
   * @param {object} [opts]
   * @param {function} [opts.onRender] - 自定义二维码渲染
   * @param {function} [opts.onStatus] - (status, resp) => void
   * @param {boolean} [opts.persist=true] - 是否持久化凭据
   * @returns {Promise<{accountId, token, baseUrl, userId}>}
   */
  async login(opts = {}) {
    const result = await authLogin({
      apiBaseUrl: this.baseUrl,
      routeTag: this.routeTag,
      ...opts,
    });
    this.setDefaultAccount(result.accountId);
    return result;
  }

  /**
   * 分段登录：先发起拿二维码（用于 Web 端展示二维码图片）。
   * @returns {Promise<{qrcodeUrl, sessionKey, message}>}
   */
  async startLogin(opts = {}) {
    return startLogin({ apiBaseUrl: this.baseUrl, routeTag: this.routeTag, ...opts });
  }

  /**
   * 分段登录：轮询扫码状态直到 confirmed。
   */
  async waitForLogin(opts = {}) {
    const result = await waitForLogin({
      apiBaseUrl: this.baseUrl,
      routeTag: this.routeTag,
      ...opts,
    });
    if (result.connected) this.setDefaultAccount(result.accountId);
    return result;
  }

  /** 退出登录：删除账号凭据 + 游标。 */
  async logout(accountId) {
    const id = accountId || this.getDefaultAccount();
    if (!id) return;
    deleteAccount(id);
    this._typingManagers.delete(id);
    log.info(`logged out`, { accountId: id });
  }

  /** 渲染二维码到终端。 */
  async renderQr(qrcodeUrl) {
    return renderQrCode(qrcodeUrl);
  }

  // ------------------------------------------------------------------
  // 长轮询（消息接收）
  // ------------------------------------------------------------------

  /**
   * 启动长轮询。阻塞调用，直到 stop() 被调用。
   *
   * @param {object} [opts]
   * @param {string} [opts.accountId] - 不传则用默认账号
   * @param {AbortSignal} [opts.signal] - 外部 abort 信号
   */
  async start(opts = {}) {
    const accountId = opts.accountId || this.getDefaultAccount();
    if (!accountId) {
      throw new Error("no account to poll: please login first");
    }
    const account = this._account(accountId);
    if (!account.configured) {
      throw new Error(`account ${accountId} not configured (no token). Run login() first.`);
    }

    // 若已有正在运行的轮询，先停掉
    this.stop(accountId);

    const controller = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this._pollingAbort = controller;

    const aLog = (level, msg, meta) => log[level](`[${accountId}] ${msg}`, meta);
    aLog("info", `WeixinBot polling started`, { baseUrl: account.baseUrl });

    await startPolling({
      baseUrl: account.baseUrl,
      token: account.token,
      accountId,
      routeTag: this.routeTag,
      loadSyncBuf: () => loadSyncBuf(accountId),
      saveSyncBuf: (buf) => saveSyncBuf(accountId, buf),
      abortSignal: controller.signal,
      // session 暂停恢复后重新读取凭据（用户可能在另一终端 --login 刷新了 token）
      reloadCredentials: () => {
        const fresh = this._account(accountId);
        return { token: fresh.token, baseUrl: fresh.baseUrl };
      },
      onMessage: async (rawMsg, aid) => {
        await this._handleInbound(rawMsg, aid);
      },
      onError: async (err) => {
        await this._emitter.emit("error", err);
        if (err.message?.includes("session expired")) {
          await this._emitter.emit("session-expired", accountId);
        }
      },
    });
  }

  /**
   * 停止长轮询。
   * @param {string} [accountId] - 不传则停所有
   */
  stop(accountId) {
    if (this._pollingAbort) {
      this._pollingAbort.abort();
      this._pollingAbort = null;
      log.info(`polling stop signal sent`, { accountId: accountId ?? "(all)" });
    }
  }

  /**
   * 处理一条入站原始消息：解析 → 记录 contextToken → 按类型分发事件。
   */
  async _handleInbound(rawMsg, accountId) {
    // 最早分发原始消息
    await this._emitter.emit("raw", rawMsg, accountId);

    // 只处理用户发来的消息（message_type === USER）
    // BOT 类型是服务器回显我们发的消息，跳过避免回环
    if (rawMsg.message_type !== undefined && rawMsg.message_type !== MessageType.USER) {
      return;
    }

    const msg = parseInbound(rawMsg, accountId);

    // 记录 contextToken 供出站使用
    if (msg.contextToken && msg.fromUserId) {
      setContextToken(accountId, msg.fromUserId, msg.contextToken);
    }

    // 自动下载媒体
    if (this.autoDownloadMedia && msg.mediaItem) {
      try {
        await this._downloadInboundMedia(msg);
      } catch (err) {
        log.error(`inbound media download failed`, { accountId, from: msg.fromUserId, err: String(err) });
        await this._emitter.emit("error", err);
      }
    }

    // 按类型分发
    await this._emitter.emit("message", msg);
    if (msg.mediaPath) {
      await this._emitter.emit("media", msg);
    }
    const t = msg.mediaItem?.type;
    if (t === MessageItemType.IMAGE) await this._emitter.emit("image", msg);
    else if (t === MessageItemType.VOICE) await this._emitter.emit("voice", msg);
    else if (t === MessageItemType.FILE) await this._emitter.emit("file", msg);
    else if (t === MessageItemType.VIDEO) await this._emitter.emit("video", msg);
    else if (msg.text && !msg.mediaItem) await this._emitter.emit("text", msg);
  }

  /**
   * 下载入站媒体到本地，填充 msg.mediaPath / msg.mediaType。
   */
  async _downloadInboundMedia(msg) {
    const item = msg.mediaItem;
    if (!item) return;
    const label = `inbound[${msg.fromUserId}]`;

    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item;
      if (!img?.media?.encrypt_query_param) return;
      const aesKeyBase64 = img.aeskey
        ? Buffer.from(img.aeskey, "hex").toString("base64")
        : img.media.aes_key;
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(img.media.encrypt_query_param, aesKeyBase64, this.cdnBaseUrl, `${label} image`)
        : await import("./media.mjs").then(m => m.downloadPlainCdnBuffer(img.media.encrypt_query_param, this.cdnBaseUrl, `${label} image`));
      msg.mediaPath = await saveBufferToFile(buf, this.inboundMediaDir, { ext: ".jpg", prefix: "wx-img" });
      msg.mediaType = "image/jpeg";
      msg.mediaBuffer = buf;
    } else if (item.type === MessageItemType.VOICE) {
      const voice = item.voice_item;
      if (!voice?.media?.encrypt_query_param || !voice.media.aes_key) return;
      const silkBuf = await downloadAndDecryptBuffer(voice.media.encrypt_query_param, voice.media.aes_key, this.cdnBaseUrl, `${label} voice`);
      const { silkToWav } = await import("./media.mjs");
      const wav = await silkToWav(silkBuf);
      if (wav) {
        msg.mediaPath = await saveBufferToFile(wav, this.inboundMediaDir, { ext: ".wav", prefix: "wx-voice" });
        msg.mediaType = "audio/wav";
        msg.mediaBuffer = wav;
      } else {
        msg.mediaPath = await saveBufferToFile(silkBuf, this.inboundMediaDir, { ext: ".silk", prefix: "wx-voice" });
        msg.mediaType = "audio/silk";
        msg.mediaBuffer = silkBuf;
      }
      // 语音转文字
      if (voice.text) msg.voiceText = voice.text;
    } else if (item.type === MessageItemType.FILE) {
      const f = item.file_item;
      if (!f?.media?.encrypt_query_param || !f.media.aes_key) return;
      const buf = await downloadAndDecryptBuffer(f.media.encrypt_query_param, f.media.aes_key, this.cdnBaseUrl, `${label} file`);
      const ext = f.file_name ? path.extname(f.file_name) || ".bin" : ".bin";
      msg.mediaPath = await saveBufferToFile(buf, this.inboundMediaDir, { ext, prefix: "wx-file", originalFilename: f.file_name });
      const { getMimeFromFilename } = await import("./mime.mjs");
      msg.mediaType = getMimeFromFilename(f.file_name ?? "file.bin");
      msg.fileName = f.file_name;
      msg.mediaBuffer = buf;
    } else if (item.type === MessageItemType.VIDEO) {
      const v = item.video_item;
      if (!v?.media?.encrypt_query_param || !v.media.aes_key) return;
      const buf = await downloadAndDecryptBuffer(v.media.encrypt_query_param, v.media.aes_key, this.cdnBaseUrl, `${label} video`);
      msg.mediaPath = await saveBufferToFile(buf, this.inboundMediaDir, { ext: ".mp4", prefix: "wx-video" });
      msg.mediaType = "video/mp4";
      msg.mediaBuffer = buf;
    }
  }

  // ------------------------------------------------------------------
  // 出站：发送消息
  // ------------------------------------------------------------------

  /**
   * 发送纯文本。
   * contextToken 缺省时自动从内存缓存取（基于 accountId + to）。
   */
  async sendText({ to, text, contextToken, accountId, timeoutMs } = {}) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    return _sendText({
      baseUrl: acc.baseUrl,
      token: acc.token,
      to,
      text,
      contextToken: ctx,
      timeoutMs,
      routeTag: this.routeTag,
    });
  }

  /**
   * 发送媒体文件（本地路径或 http(s) URL），按 MIME 自动路由。
   */
  async sendMedia({ to, mediaUrl, text = "", contextToken, accountId, timeoutMs, destDir } = {}) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    return _sendMedia({
      baseUrl: acc.baseUrl,
      token: acc.token,
      to,
      mediaUrl,
      text,
      contextToken: ctx,
      timeoutMs,
      routeTag: this.routeTag,
      cdnBaseUrl: this.cdnBaseUrl,
      destDir,
    });
  }

  /** 发送本地图片。 */
  async sendImageFile({ to, filePath, text = "", contextToken, accountId, timeoutMs } = {}) {
    return this._sendUploadedMedia({ to, filePath, text, contextToken, accountId, timeoutMs, kind: "image" });
  }

  /** 发送本地视频。 */
  async sendVideoFile({ to, filePath, text = "", contextToken, accountId, timeoutMs } = {}) {
    return this._sendUploadedMedia({ to, filePath, text, contextToken, accountId, timeoutMs, kind: "video" });
  }

  /** 发送本地文件附件。 */
  async sendFileAttachment({ to, filePath, text = "", contextToken, accountId, timeoutMs } = {}) {
    return this._sendUploadedMedia({ to, filePath, text, contextToken, accountId, timeoutMs, kind: "file" });
  }

  async _sendUploadedMedia({ to, filePath, text, contextToken, accountId, timeoutMs, kind }) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    const uploadOpts = { baseUrl: acc.baseUrl, token: acc.token, routeTag: this.routeTag };
    const uploaded = await uploadLocalFile({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl: this.cdnBaseUrl });
    const sendArgs = { baseUrl: acc.baseUrl, token: acc.token, to, text, uploaded, contextToken: ctx, timeoutMs, routeTag: this.routeTag };
    if (kind === "image") return _sendImage(sendArgs);
    if (kind === "video") return _sendVideo(sendArgs);
    return _sendFile({ ...sendArgs, fileName: path.basename(filePath) });
  }

  /**
   * 创建流式回复会话。
   * push(chunk): 发送 GENERATING 状态的增量；finish(fullText): 发送 FINISH 的最终消息。
   */
  createReplyStream({ to, contextToken, accountId, timeoutMs } = {}) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    return _createReplyStream({
      baseUrl: acc.baseUrl,
      token: acc.token,
      to,
      contextToken: ctx,
      timeoutMs,
      routeTag: this.routeTag,
    });
  }

  /**
   * 回复一条入站消息（自动带上入站消息的 contextToken / fromUserId）。
   */
  async reply(inboundMsg, text, { accountId } = {}) {
    return this.sendText({
      to: inboundMsg.fromUserId,
      text,
      contextToken: inboundMsg.contextToken,
      accountId: accountId || inboundMsg.accountId,
    });
  }

  /**
   * 用媒体回复一条入站消息。
   */
  async replyWithMedia(inboundMsg, mediaUrl, text = "", { accountId } = {}) {
    return this.sendMedia({
      to: inboundMsg.fromUserId,
      mediaUrl,
      text,
      contextToken: inboundMsg.contextToken,
      accountId: accountId || inboundMsg.accountId,
    });
  }

  // ------------------------------------------------------------------
  // Typing 状态
  // ------------------------------------------------------------------

  _typingManager(accountId) {
    const acc = this._account(accountId);
    let mgr = this._typingManagers.get(acc.accountId);
    if (!mgr) {
      mgr = new TypingTicketManager({ baseUrl: acc.baseUrl, token: acc.token, routeTag: this.routeTag });
      this._typingManagers.set(acc.accountId, mgr);
    }
    return mgr;
  }

  /**
   * 在 AI 生成回复期间显示"正在输入"。
   * 返回控制器：调用 .start() 开始，.stop() 结束。
   *
   * @returns {Promise<{start:()=>Promise<void>, stop:()=>Promise<void>}>}
   */
  async typing({ to, contextToken, accountId } = {}) {
    const acc = this._account(accountId);
    const mgr = this._typingManager(acc.accountId);
    const ticket = await mgr.getForUser(to, contextToken);
    return createTypingController({
      userId: to,
      typingTicket: ticket,
      baseUrl: acc.baseUrl,
      token: acc.token,
      routeTag: this.routeTag,
    });
  }

  // ------------------------------------------------------------------
  // 状态查询
  // ------------------------------------------------------------------

  /** 账号是否暂停（session 过期冷却期）。 */
  isPaused(accountId) {
    const id = accountId || this.getDefaultAccount();
    return id ? isSessionPaused(id) : false;
  }

  /** 获取账号信息（不返回 token）。 */
  getAccountInfo(accountId) {
    const id = accountId || this.getDefaultAccount();
    if (!id) return null;
    const acc = this._account(id);
    const stored = loadAccount(id) ?? {};
    return {
      accountId: acc.accountId,
      baseUrl: acc.baseUrl,
      cdnBaseUrl: acc.cdnBaseUrl,
      configured: acc.configured,
      userId: stored.userId,
      savedAt: stored.savedAt,
      paused: isSessionPaused(id),
    };
  }
}

// ---------------------------------------------------------------------------
// 具名导出：所有子模块的能力，供进阶用户按需引入
// ---------------------------------------------------------------------------

export { WeixinBot };
export * from "./constants.mjs";
export {
  WeixinHttpError,
  WeixinApiError,
  WeixinTimeoutError,
  getUpdates,
  getUploadUrl,
  sendMessage,
  getConfig,
  sendTyping,
  buildHeaders,
  buildBaseInfo,
} from "./http.mjs";
export {
  login,
  startLogin,
  waitForLogin,
  loadAccount,
  saveAccount,
  deleteAccount,
  listAccountIds,
  resolveAccount,
  loadSyncBuf,
  saveSyncBuf,
  renderQrCode,
} from "./auth.mjs";
export {
  encryptAesEcb,
  decryptAesEcb,
  aesEcbPaddedSize,
} from "./crypto.mjs";
export {
  uploadLocalFile,
  uploadImage,
  uploadVideo,
  uploadFileAttachment,
  uploadBuffer,
  uploadBufferToCdn,
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
  downloadRemoteUrlToTemp,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  parseAesKey,
  saveBufferToFile,
  silkToWav,
  UploadedFileInfo,
} from "./media.mjs";
export {
  sendText,
  sendMedia,
  sendImage,
  sendVideo,
  sendFile,
  createReplyStream,
  parseInbound,
  extractText,
  isMediaItem,
  markdownToPlainText,
  setContextToken,
  getContextToken,
  buildImageItem,
  buildVideoItem,
  buildFileItem,
} from "./messaging.mjs";
export { TypingTicketManager, createTypingController } from "./typing.mjs";
export { startPolling } from "./poller.mjs";
export {
  pauseSession,
  isSessionPaused,
  getRemainingPauseMs,
  assertSessionActive,
} from "./session-guard.mjs";
export {
  getMimeFromFilename,
  getExtensionFromMime,
  getExtensionFromContentTypeOrUrl,
} from "./mime.mjs";
export {
  log,
  generateId,
  redactToken,
  redactBody,
  redactUrl,
  resolveStateDir,
  normalizeAccountId,
  sleep,
} from "./util.mjs";

export default WeixinBot;
