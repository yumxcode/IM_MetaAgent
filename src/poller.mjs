/**
 * 长轮询主循环
 *
 * 核心职责：
 *  - 持续调用 getUpdates（服务器最多 hold 35s）
 *  - 维护并持久化 get_updates_buf 游标（重启可续接）
 *  - 错误处理：
 *      session 过期（errcode=-14）→ 暂停 1 小时
 *      连续失败 ≥3 次 → 退避 30s
 *      普通失败 → 2s 后重试
 *  - 通过 onMessage 回调将每条入站消息交给上层
 *
 * 该模块不绑定具体的"如何处理消息"逻辑，只负责"拉取 + 分发"，
 * 与任何外部框架完全解耦。
 *
 * 与官方插件的 monitor 模块行为对齐。
 */
import { getUpdates } from "./http.mjs";
import {
  pauseSession,
  getRemainingPauseMs,
  isSessionPaused,
} from "./session-guard.mjs";
import {
  BACKOFF_DELAY_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
} from "./constants.mjs";
import { log, sleep } from "./util.mjs";

/**
 * 启动长轮询循环，直到 abortSignal 触发。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.token]
 * @param {string} opts.accountId
 * @param {string} [opts.initialGetUpdatesBuf] - 初始游标（优先于持久化值）
 * @param {function} [opts.loadSyncBuf] - () => string|null 加载持久化游标
 * @param {function} [opts.saveSyncBuf] - (buf) => void 持久化游标
 * @param {function} opts.onMessage - (WeixinMessage, accountId) => void|Promise 每条消息回调
 * @param {function} [opts.onError] - (err) => void 错误回调（不抛出，仅通知）
 * @param {AbortSignal} [opts.abortSignal]
 * @param {number} [opts.longPollTimeoutMs]
 * @param {string} [opts.routeTag]
 * @param {function} [opts.shouldPause] - (accountId) => boolean 自定义暂停判断
 */
export async function startPolling(opts) {
  const {
    baseUrl,
    token,
    accountId,
    initialGetUpdatesBuf,
    loadSyncBuf,
    saveSyncBuf,
    onMessage,
    onError,
    abortSignal,
    longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
    routeTag,
    shouldPause = isSessionPaused,
    reloadCredentials,
  } = opts;

  const aLog = (level, msg, meta) => log[level](`[${accountId}] ${msg}`, meta);

  // 可变凭据：session 暂停恢复后通过 reloadCredentials() 刷新
  // （用户可能在另一终端 --login 扫码，token 已写入文件）
  let currentToken = token;
  let currentBaseUrl = baseUrl;

  /** 暂停恢复后重新加载凭据，使刷新后的 token 立即生效。 */
  const refreshCreds = () => {
    if (!reloadCredentials) return;
    try {
      const fresh = reloadCredentials();
      if (fresh?.token) {
        currentToken = fresh.token;
        aLog("info", `credentials reloaded after session pause`);
      }
      if (fresh?.baseUrl) currentBaseUrl = fresh.baseUrl;
    } catch (err) {
      aLog("warn", `reloadCredentials failed, keeping previous token`, { err: String(err) });
    }
  };

  // 初始游标：参数 > 持久化值 > 空字符串
  let getUpdatesBuf = initialGetUpdatesBuf ?? loadSyncBuf?.() ?? "";
  aLog("info", `polling started`, { baseUrl: currentBaseUrl, hasBuf: Boolean(getUpdatesBuf), bufLen: getUpdatesBuf.length });

  let nextTimeoutMs = longPollTimeoutMs;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    // 主动检查暂停状态（被外部 pause）
    if (shouldPause(accountId)) {
      const pauseMs = getRemainingPauseMs(accountId);
      aLog("warn", `session paused, sleeping ${Math.ceil(pauseMs / 60_000)} min`);
      try {
        await sleep(pauseMs, abortSignal);
      } catch {
        // aborted
      }
      refreshCreds();
      continue;
    }

    try {
      aLog("debug", `getUpdates`, { bufHead: getUpdatesBuf.slice(0, 50), timeoutMs: nextTimeoutMs });
      const resp = await getUpdates({
        baseUrl: currentBaseUrl,
        token: currentToken,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        routeTag,
      });

      // 服务器建议的下次长轮询超时
      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      // 业务错误检测
      const isError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        const isSessionExpired = resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          aLog("error", `session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(pauseMs / 60_000)} min`, { errmsg: resp.errmsg });
          onError?.(new Error(`session expired: ${resp.errmsg ?? ""}`));
          consecutiveFailures = 0;
          try { await sleep(pauseMs, abortSignal); } catch { /* aborted */ }
          refreshCreds();
          continue;
        }
        consecutiveFailures += 1;
        aLog("warn", `getUpdates failed`, { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg, count: `${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}` });
        onError?.(new Error(`getUpdates: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`));
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          aLog("error", `${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          try { await sleep(BACKOFF_DELAY_MS, abortSignal); } catch { /* aborted */ }
        } else {
          try { await sleep(RETRY_DELAY_MS, abortSignal); } catch { /* aborted */ }
        }
        continue;
      }

      // 成功：重置失败计数
      consecutiveFailures = 0;

      // 更新游标
      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBuf?.(getUpdatesBuf);
      }

      // 分发消息
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        try {
          await onMessage?.(msg, accountId);
        } catch (err) {
          aLog("error", `onMessage handler threw`, { err: String(err), from: msg.from_user_id });
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog("info", `polling stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      aLog("warn", `getUpdates error`, { err: String(err), count: `${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}` });
      onError?.(err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        aLog("error", `${MAX_CONSECUTIVE_FAILURES} consecutive errors, backing off ${BACKOFF_DELAY_MS / 1000}s`);
        consecutiveFailures = 0;
        try { await sleep(BACKOFF_DELAY_MS, abortSignal); } catch { /* aborted */ }
      } else {
        try { await sleep(2000, abortSignal); } catch { /* aborted */ }
      }
    }
  }
  aLog("info", `polling ended`);
}
