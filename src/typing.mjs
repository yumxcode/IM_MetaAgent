/**
 * Typing 状态模块：getConfig 缓存 + sendTyping
 *
 * 微信协议要求发送"正在输入"指示前先通过 getConfig 获取 typing_ticket。
 * typing_ticket 有较长的有效期，所以做按用户缓存 + 定期随机刷新 + 失败指数退避。
 *
 * 与官方插件的 config-cache 模块行为对齐。
 */
import { getConfig, sendTyping } from "./http.mjs";
import { log } from "./util.mjs";
import { TypingStatus } from "./constants.mjs";

const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1000; // 1h

/**
 * Per-user getConfig 缓存管理器。
 *
 * 缓存策略：
 *  - 首次获取后，nextFetchAt = now + random(0, 24h)（随机刷新避免雪崩）
 *  - 获取失败：指数退避（2s → 4s → 8s ... 上限 1h），失败时返回上次成功的 ticket
 */
export class TypingTicketManager {
  constructor({ baseUrl, token, routeTag } = {}) {
    this.apiOpts = { baseUrl, token, routeTag };
    /** @type {Map<string, {typingTicket:string, everSucceeded:boolean, nextFetchAt:number, retryDelayMs:number}>} */
    this.cache = new Map();
  }

  /**
   * 获取指定用户的 typing_ticket（带缓存）。
   * @param {string} userId - ilink_user_id
   * @param {string} [contextToken]
   * @returns {Promise<string>} typing_ticket（可能为空字符串）
   */
  async getForUser(userId, contextToken) {
    const now = Date.now();
    const entry = this.cache.get(userId);
    const shouldFetch = !entry || now >= entry.nextFetchAt;

    if (shouldFetch) {
      let fetchOk = false;
      try {
        const resp = await getConfig({
          baseUrl: this.apiOpts.baseUrl,
          token: this.apiOpts.token,
          ilinkUserId: userId,
          contextToken,
          routeTag: this.apiOpts.routeTag,
        });
        if (resp.ret === 0) {
          this.cache.set(userId, {
            typingTicket: resp.typing_ticket ?? "",
            everSucceeded: true,
            nextFetchAt: now + Math.random() * CONFIG_CACHE_TTL_MS,
            retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
          });
          log.debug(`typing ticket cached for ${userId}`);
          fetchOk = true;
        }
      } catch (err) {
        log.warn(`getConfig (typing ticket) failed for ${userId}`, { err: String(err) });
      }
      if (!fetchOk) {
        const prevDelay = entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS;
        const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_MS);
        if (entry) {
          entry.nextFetchAt = now + nextDelay;
          entry.retryDelayMs = nextDelay;
        } else {
          this.cache.set(userId, {
            typingTicket: "",
            everSucceeded: false,
            nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS,
            retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
          });
        }
      }
    }

    return this.cache.get(userId)?.typingTicket ?? "";
  }
}

/**
 * 创建一个 typing 控制器，封装 start/stop 两个回调。
 * 用于在 AI 生成回复期间周期性发送 typing，生成完毕后取消。
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.typingTicket] - 为空时 start/stop 为 no-op
 * @param {string} opts.baseUrl
 * @param {string} [opts.token]
 * @param {number} [opts.keepaliveIntervalMs=5000]
 * @returns {{start:()=>Promise<void>, stop:()=>Promise<void>}}
 */
export function createTypingController(opts) {
  const { userId, typingTicket, baseUrl, token, keepaliveIntervalMs = 5000, routeTag } = opts;
  const hasTicket = Boolean(typingTicket);
  let timer = null;
  let running = false;

  const send = (status) => {
    if (!hasTicket) return Promise.resolve();
    return sendTyping({
      baseUrl,
      token,
      ilinkUserId: userId,
      typingTicket,
      status,
      routeTag,
    }).catch((err) => {
      log.warn(`typing ${status === TypingStatus.TYPING ? "start" : "stop"} error`, { err: String(err) });
    });
  };

  return {
    async start() {
      if (!hasTicket || running) return;
      running = true;
      await send(TypingStatus.TYPING);
      // 周期性续期（微信 typing 状态有时效）
      timer = setInterval(() => {
        if (running) send(TypingStatus.TYPING).catch(() => {});
      }, keepaliveIntervalMs);
    },
    async stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (hasTicket) await send(TypingStatus.CANCEL);
    },
  };
}
