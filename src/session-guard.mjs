/**
 * Session Guard：会话过期检测与暂停
 *
 * 当服务器返回 errcode=-14（session 过期）时，暂停该账号的所有请求 1 小时，
 * 避免在 token 失效期间持续重试造成更严重的封禁风险。
 *
 * 与官方插件的 session-guard 模块行为对齐。
 */
import {
  SESSION_EXPIRED_ERRCODE,
  SESSION_PAUSE_DURATION_MS,
} from "./constants.mjs";
import { log } from "./util.mjs";

const pauseUntilMap = new Map();

/** 暂停某账号的所有请求 1 小时。 */
export function pauseSession(accountId) {
  const until = Date.now() + SESSION_PAUSE_DURATION_MS;
  pauseUntilMap.set(accountId, until);
  log.info(`session-guard: paused`, {
    accountId,
    until: new Date(until).toISOString(),
    minutes: SESSION_PAUSE_DURATION_MS / 60_000,
  });
}

/** 账号是否处于暂停期。 */
export function isSessionPaused(accountId) {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    pauseUntilMap.delete(accountId);
    return false;
  }
  return true;
}

/** 暂停剩余毫秒数（未暂停返回 0）。 */
export function getRemainingPauseMs(accountId) {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    pauseUntilMap.delete(accountId);
    return 0;
  }
  return remaining;
}

/** 若账号处于暂停期则抛错（在出站请求前调用）。 */
export function assertSessionActive(accountId) {
  if (isSessionPaused(accountId)) {
    const remainingMin = Math.ceil(getRemainingPauseMs(accountId) / 60_000);
    throw new Error(
      `session paused for accountId=${accountId}, ${remainingMin} min remaining (errcode ${SESSION_EXPIRED_ERRCODE})`,
    );
  }
}

/** 测试用：重置所有暂停状态。 */
export function _resetSessionGuardForTest() {
  pauseUntilMap.clear();
}
