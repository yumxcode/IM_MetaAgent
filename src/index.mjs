/**
 * WeixinBot —— 完备的微信 iLink Bot 接入层主类
 *
 * 设计目标：
 *  - 零框架依赖（仅依赖 Node.js >= 20.18 的内置 fetch / crypto）
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
import fs from "node:fs/promises";
import path from "node:path";

import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
  MessageItemType,
  MessageType,
} from "./constants.mjs";
import { notifyStart, notifyStop } from "./http.mjs";
import { QuoteStore, resolveQuoteCachePolicy, resolveQuoteMediaDirectory, deleteQuoteCacheForAccount } from "./quote-store.mjs";
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
  sendVoice as _sendVoice,
  sendToolProgress as _sendToolProgress,
  createReplyStream as _createReplyStream,
  parseInbound,
  extractText,
  isMediaItem,
  setContextToken,
  getContextToken,
  clearContextTokens,
} from "./messaging.mjs";
import { uploadLocalFile, uploadImage, uploadVideo, uploadVoice, uploadFileAttachment, downloadAndDecryptBuffer, downloadPlainCdnBuffer, saveBufferToFile } from "./media.mjs";
import { TypingTicketManager, createTypingController } from "./typing.mjs";
import { startPolling } from "./poller.mjs";
import { isSessionPaused, assertSessionActive, clearSessionPause } from "./session-guard.mjs";
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
    this._baseUrlOverride = opts.baseUrl;
    this.cdnBaseUrl = opts.cdnBaseUrl || CDN_BASE_URL;
    this.routeTag = opts.routeTag;
    this.inboundMediaDir = opts.inboundMediaDir;
    this.autoDownloadMedia = opts.autoDownloadMedia !== false;
    this.inboundHandler = opts.inboundHandler;

    this._emitter = createEmitter();
    this._typingManagers = new Map(); // accountId -> TypingTicketManager
    this._polling = new Map();
    this._pollingFn = opts.pollingFn || startPolling;
    this._notifyStart = opts.notifyStartFn || notifyStart;
    this._notifyStop = opts.notifyStopFn || notifyStop;
    this._quotePolicy = resolveQuoteCachePolicy({ channels: { "openclaw-weixin": { quoteCache: opts.quoteCache ?? { enabled: process.env.WEIXIN_QUOTE_CACHE_ENABLED !== "false" } } } });
    this._quoteStore = null;
    this._quoteOpen = null;
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
   *  - recovered: ({ accountId, since, downMs }) => 轮询失败或会话过期后首次恢复
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
    if (this._defaultAccountId) return this._defaultAccountId;
    if (process.env.WEIXIN_ACCOUNT_ID?.trim()) return process.env.WEIXIN_ACCOUNT_ID.trim();
    return this.listAccounts().map(id => ({ id, data: loadAccount(id) }))
      .filter(account => account.data?.token)
      .sort((a, b) => (Date.parse(b.data.savedAt) || 0) - (Date.parse(a.data.savedAt) || 0))[0]?.id;

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
      baseUrl: this._baseUrlOverride,
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
    if (result.connected !== false && result.accountId) {
      this.setDefaultAccount(result.accountId);
      clearSessionPause(result.accountId);
      this._typingManagers.delete(result.accountId);
    }
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
    if (result.connected) { this.setDefaultAccount(result.accountId); clearSessionPause(result.accountId); this._typingManagers.delete(result.accountId); }
    return result;
  }

  /** 退出登录：删除账号凭据 + 游标。 */
  async logout(accountId) {
    const id = accountId || this.getDefaultAccount();
    if (!id) return;
    await this.stop(id);
    deleteAccount(id);
    clearContextTokens(id);
    if (this._quoteStore) this._quoteStore.deleteAccount(id);
    else deleteQuoteCacheForAccount(id);
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
    if (!accountId) throw new Error("no account to poll: please login first");
    const account = this._account(accountId);
    if (!account.configured) throw new Error(`account ${accountId} has no token`);
    await this.stop(accountId);
    await this._ensureQuoteStore();
    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    else opts.signal?.addEventListener("abort", externalAbort, { once: true });
    let done;
    const state = { controller, done: new Promise(resolve => { done = resolve; }) };
    this._polling.set(accountId, state);
    try {
      if (controller.signal.aborted) return;
      await this._notifyStart({ baseUrl: account.baseUrl, token: account.token, routeTag: this.routeTag, timeoutMs: 3000, signal: controller.signal }).catch(err => log.warn("notifyStart failed", { err: err.name }));
      log.info("WeixinBot polling started", { accountId, baseUrl: account.baseUrl });
      await this._pollingFn({
        baseUrl: account.baseUrl, token: account.token, accountId, routeTag: this.routeTag,
        loadSyncBuf: () => loadSyncBuf(accountId), saveSyncBuf: buf => saveSyncBuf(accountId, buf),
        abortSignal: controller.signal,
        reloadCredentials: () => { const fresh = this._account(accountId); return { token: fresh.token, baseUrl: fresh.baseUrl }; },
        ackAfterHandle: Boolean(this.inboundHandler),
        onMessage: (raw, id) => this._handleInbound(raw, id),
        onHealthy: info => this._emitter.emit("recovered", info),
        onError: async err => {
          await this._emitter.emit("error", err);
          if (err.errcode === -14 || err.ret === -14 || err.isStaleToken || err.message?.includes("session expired")) await this._emitter.emit("session-expired", accountId);
        },
      });
    } finally {
      opts.signal?.removeEventListener("abort", externalAbort);
      try {
        let fresh = account;
        try { const reloaded = this._account(accountId); if (reloaded.configured) fresh = reloaded; } catch {}
        await this._notifyStop({ baseUrl: fresh.baseUrl, token: fresh.token, routeTag: this.routeTag, timeoutMs: 3000 }).catch(err => log.warn("notifyStop failed", { err: err.name }));
      } finally {
        if (this._polling.get(accountId) === state) this._polling.delete(accountId);
        done();
      }
    }
  }

  async stop(accountId) {
    const states = accountId ? [this._polling.get(accountId)].filter(Boolean) : [...this._polling.values()];
    for (const state of states) state.controller.abort();
    await Promise.all(states.map(state => state.done));
    if (!accountId) {
      this._quoteStore?.close(); this._quoteStore = null; this._quoteOpen = null;
      this._typingManagers.clear();
    }
  }

  async _ensureQuoteStore() {
    if (!this._quoteOpen) this._quoteOpen = QuoteStore.open({ policy: this._quotePolicy }).then(store => (this._quoteStore = store));
    return this._quoteOpen;
  }

  async _cacheSent(acc, to, record) {
    if (!record.serverMessageId) return;
    try {
      const store = await this._ensureQuoteStore();
      if (!store) return;
      let sourceMediaPath, mediaMime;
      if (record.sourceMediaPath && (await fs.stat(record.sourceMediaPath)).size <= store.policy.maxSingleMediaBytes) {
        const dir = resolveQuoteMediaDirectory(acc.accountId);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        sourceMediaPath = path.join(dir, generateId("sent") + path.extname(record.sourceMediaPath));
        await fs.copyFile(record.sourceMediaPath, sourceMediaPath);
        mediaMime = (await import("./mime.mjs")).getMimeFromFilename(record.sourceMediaPath);
      }
      await store.put({ accountId: acc.accountId, conversationId: to, messageId: String(record.serverMessageId), direction: "outbound", body: record.body || "", sourceMediaPath, mediaMime, mediaName: record.mediaName });
    } catch (err) { log.warn("outbound quote cache failed", { err: err.name }); }
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

    const msg = parseInbound(rawMsg, accountId, await this._ensureQuoteStore());
    const cachedMedia = msg.quotes.find(q => q.mediaPath);
    if (!msg.mediaItem && cachedMedia) {
      if (await fs.stat(cachedMedia.mediaPath).then(stat => stat.isFile()).catch(() => false)) {
        msg.mediaPath = cachedMedia.mediaPath; msg.mediaType = cachedMedia.mediaMime; msg.fileName = cachedMedia.mediaName;
      }
    }

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
        if (this.inboundHandler) throw err;
      }
    }

    if (msg.messageId && this._quoteStore) {
      try { await this._quoteStore.put({ accountId, conversationId: msg.groupId || msg.fromUserId, messageId: String(msg.messageId), direction: "inbound", body: msg.commandText, sourceMediaPath: msg.mediaPath, mediaMime: msg.mediaType, mediaName: msg.fileName }); }
      catch (err) { log.warn("inbound quote cache failed", { err: err.name }); }
    }
    // Durable consumer failures must propagate to the poller; observers remain best effort.
    if (this.inboundHandler) await this.inboundHandler(msg);
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
    const value = item?.image_item || item?.voice_item || item?.file_item || item?.video_item;
    if (!value?.media) return;
    const media = { ...value.media };
    if (value.aeskey) media.aes_key = Buffer.from(value.aeskey).toString("base64");
    const options = { cdnBaseUrl: this.cdnBaseUrl, label: "inbound media", timeoutMs: 30000, signal: this._polling.get(msg.accountId)?.controller.signal };
    let buf = media.aes_key ? await downloadAndDecryptBuffer(media, options) : await downloadPlainCdnBuffer(media, options);
    let ext = ".bin", mime = "application/octet-stream";
    if (item.type === MessageItemType.IMAGE) { ext = ".jpg"; mime = "image/jpeg"; }
    if (item.type === MessageItemType.VIDEO) { ext = ".mp4"; mime = "video/mp4"; }
    if (item.type === MessageItemType.FILE) {
      ext = path.extname(value.file_name || "") || ".bin";
      mime = (await import("./mime.mjs")).getMimeFromFilename(value.file_name || "file.bin"); msg.fileName = value.file_name;
    }
    if (item.type === MessageItemType.VOICE) {
      const code = value.encode_type ?? 6;
      ext = code === 7 ? ".mp3" : code === 8 ? ".ogg" : code === 1 ? ".pcm" : ".silk";
      mime = code === 7 ? "audio/mpeg" : code === 8 ? "audio/ogg" : code === 1 ? "audio/pcm" : "audio/silk";
      if (code === 6) {
        const wav = await (await import("./media.mjs")).silkToWav(buf);
        if (wav) { buf = wav; ext = ".wav"; mime = "audio/wav"; }
      }
      if (value.text) msg.voiceText = value.text;
    }
    const cacheable = this._quoteStore && buf.length <= this._quoteStore.policy.maxSingleMediaBytes;
    const dir = this.inboundMediaDir || (cacheable ? resolveQuoteMediaDirectory(msg.accountId) : defaultInboundMediaDir());
    msg.mediaPath = await saveBufferToFile(buf, dir, { ext, prefix: "wx-media", originalFilename: value.file_name });
    msg.mediaType = mime; msg.mediaBuffer = buf;
  }

  // ------------------------------------------------------------------
  // 出站：发送消息
  // ------------------------------------------------------------------

  /**
   * 发送纯文本。
   * contextToken 缺省时自动从内存缓存取（基于 accountId + to）。
   */
  async sendText({ to, text, contextToken, accountId, timeoutMs, runId, signal, clientId } = {}) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    return _sendText({
      baseUrl: acc.baseUrl,
      token: acc.token,
      to,
      text,
      contextToken: ctx,
      timeoutMs, runId, signal, clientId, onSent: record => this._cacheSent(acc, to, record),
      routeTag: this.routeTag,
    });
  }

  /**
   * 发送媒体文件（本地路径或 http(s) URL），按 MIME 自动路由。
   */
  async sendMedia({ to, mediaUrl, text = "", contextToken, accountId, timeoutMs, destDir, runId, signal } = {}) {
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
      timeoutMs, runId, signal, onSent: record => this._cacheSent(acc, to, record),
      routeTag: this.routeTag,
      cdnBaseUrl: this.cdnBaseUrl,
      destDir,
    });
  }

  sendImageFile(opts = {}) { return this._sendUploadedMedia({ ...opts, kind: "image" }); }
  sendVideoFile(opts = {}) { return this._sendUploadedMedia({ ...opts, kind: "video" }); }
  sendFileAttachment(opts = {}) { return this._sendUploadedMedia({ ...opts, kind: "file" }); }
  sendVoiceFile(opts = {}) { return this._sendUploadedMedia({ ...opts, kind: "voice" }); }
  async _sendUploadedMedia({ to, filePath, text, contextToken, accountId, timeoutMs, kind, runId, signal, sampleRate, playtime }) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    const opts = { baseUrl: acc.baseUrl, token: acc.token, routeTag: this.routeTag, timeoutMs, signal };
    const uploader = { image: uploadImage, video: uploadVideo, voice: uploadVoice, file: uploadFileAttachment }[kind];
    const uploaded = await uploader({ filePath, toUserId: to, opts, cdnBaseUrl: this.cdnBaseUrl });
    const sendArgs = { ...opts, to, text, uploaded, contextToken: ctx, runId, sampleRate, playtime, sourceMediaPath: filePath, onSent: record => this._cacheSent(acc, to, record) };
    const sender = { image: _sendImage, video: _sendVideo, voice: _sendVoice, file: _sendFile }[kind];
    return sender({ ...sendArgs, fileName: path.basename(filePath) });
  }
  async sendToolProgress({ accountId, to, contextToken, ...opts } = {}) {
    const acc = this._account(accountId); assertSessionActive(acc.accountId);
    return _sendToolProgress({ ...opts, to, contextToken: contextToken ?? getContextToken(acc.accountId, to), baseUrl: acc.baseUrl, token: acc.token, routeTag: this.routeTag });
  }

  /**
   * 创建流式回复会话。
   * push(chunk): 发送 GENERATING 状态的增量；finish(fullText): 发送 FINISH 的最终消息。
   */
  createReplyStream({ to, contextToken, accountId, timeoutMs, runId, signal } = {}) {
    const acc = this._account(accountId);
    assertSessionActive(acc.accountId);
    const ctx = contextToken ?? getContextToken(acc.accountId, to);
    return _createReplyStream({
      baseUrl: acc.baseUrl,
      token: acc.token,
      to,
      contextToken: ctx,
      timeoutMs, runId, signal, onSent: record => this._cacheSent(acc, to, record),
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
      runId: inboundMsg.runId,
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
      runId: inboundMsg.runId,
    });
  }

  // ------------------------------------------------------------------
  // Typing 状态
  // ------------------------------------------------------------------

  _typingManager(accountId) {
    const acc = this._account(accountId);
    let mgr = this._typingManagers.get(acc.accountId);
    if (!mgr || mgr._credentialKey !== acc.token + acc.baseUrl) {
      mgr = new TypingTicketManager({ baseUrl: acc.baseUrl, token: acc.token, routeTag: this.routeTag });
      mgr._credentialKey = acc.token + acc.baseUrl;
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
  notifyStart,
  notifyStop,
  buildAppHeaders,
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
  uploadVoice,
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
  sendVoice,
  sendToolProgress,
  buildVoiceItem,
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
  clearSessionPause,
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

export { QuoteStore, resolveQuoteCachePolicy } from "./quote-store.mjs";
export { StreamingMarkdownFilter } from "./markdown-filter.mjs";
export { resolvePartialQuote } from "./partial-quote.mjs";
export default WeixinBot;
