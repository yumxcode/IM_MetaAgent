/** Abortable long polling with persistent cursors and stale-token cooldown. */
import { getUpdates, WeixinApiError, classifyFetchError } from "./http.mjs";
import { clearSessionPause, pauseSession, getRemainingPauseMs, isSessionPaused } from "./session-guard.mjs";
import {
  BACKOFF_DELAY_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
} from "./constants.mjs";
import { log, sleep, redactUrl } from "./util.mjs";

/**
 * Callbacks retain their original contracts. getUpdatesFn / sleepFn are optional
 * injection points for integration tests, without network or one-hour waits.
 */
export async function startPolling(opts) {
  const {
    baseUrl, token, accountId, initialGetUpdatesBuf, loadSyncBuf, saveSyncBuf,
    onMessage, onError, abortSignal, routeTag,
    longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
    shouldPause = isSessionPaused, reloadCredentials,
    getUpdatesFn = getUpdates, sleepFn = sleep,
    minEmptyPollDelayMs = 250,
    pauseCheckIntervalMs = 5_000,
  } = opts;
  const aLog = (level, message, meta) => log[level](`[${accountId}] ${message}`, meta);
  let currentToken = token;
  let currentBaseUrl = baseUrl;
  let currentRouteTag = routeTag;
  let getUpdatesBuf = initialGetUpdatesBuf ?? loadSyncBuf?.() ?? "";
  let nextTimeoutMs = longPollTimeoutMs;
  let consecutiveFailures = 0;
  let wasPaused = false;

  const reportError = async (err) => {
    try { await onError?.(err); } catch { aLog("warn", "onError callback threw"); }
  };
  const wait = async (duration) => {
    if (abortSignal?.aborted) return;
    try { await sleepFn(duration, abortSignal); } catch (err) {
      if (!abortSignal?.aborted) throw err;
    }
  };
  const refreshCreds = async () => {
    if (!reloadCredentials || abortSignal?.aborted) return false;
    try {
      const fresh = await reloadCredentials();
      const changed = Boolean(fresh?.token && fresh.token !== currentToken);
      if (fresh?.token) currentToken = fresh.token;
      if (fresh?.baseUrl) currentBaseUrl = fresh.baseUrl;
      if (fresh?.routeTag !== undefined) currentRouteTag = fresh.routeTag;
      if (changed) {
        clearSessionPause(accountId);
        aLog("info", "new credentials loaded; stale-token cooldown cleared");
      }
      return changed;
    } catch { aLog("warn", "reloadCredentials failed; retaining existing credentials"); return false; }
  };

  aLog("info", "polling started", { baseUrl: redactUrl(currentBaseUrl), hasBuf: Boolean(getUpdatesBuf), bufLen: getUpdatesBuf.length });
  while (!abortSignal?.aborted) {
    if (shouldPause(accountId)) {
      wasPaused = true;
      if (await refreshCreds()) continue;
      if (abortSignal?.aborted) break;
      const pauseMs = getRemainingPauseMs(accountId);
      // A custom pause predicate may not have a guard entry; still avoid spinning.
      await wait(Math.min(pauseMs || RETRY_DELAY_MS, Math.max(1, pauseCheckIntervalMs)));
      continue;
    }
    if (wasPaused) {
      await refreshCreds();
      wasPaused = false;
      if (abortSignal?.aborted) break;
    }
    try {
      const startedAt = Date.now();
      aLog("debug", "getUpdates", { bufLen: getUpdatesBuf.length, timeoutMs: nextTimeoutMs });
      const resp = await getUpdatesFn({
        baseUrl: currentBaseUrl, token: currentToken, getUpdatesBuf,
        timeoutMs: nextTimeoutMs, routeTag: currentRouteTag, abortSignal,
      });
      // getUpdates returns empty success on external abort, so stop before cursor
      // writes or callbacks and do not immediately schedule another request.
      if (abortSignal?.aborted) break;
      if (!resp || typeof resp !== "object") throw new Error("getUpdates returned an invalid response");
      if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
        throw new WeixinApiError(`getUpdates: ret=${resp.ret} errcode=${resp.errcode}`, { ret: resp.ret, errcode: resp.errcode, endpoint: "getUpdates" });
      }
      if (Number.isFinite(resp.longpolling_timeout_ms) && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }
      consecutiveFailures = 0;
      if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== "") {
        getUpdatesBuf = resp.get_updates_buf;
        await saveSyncBuf?.(getUpdatesBuf);
      }
      const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
      for (const msg of msgs) {
        if (abortSignal?.aborted) break;
        try { await onMessage?.(msg, accountId); }
        catch { aLog("error", "onMessage handler threw", { from: msg.from_user_id }); }
      }
      // Empty polls should normally be held by the server. Defend against an
      // immediate empty response (or zero-duration test timeout) causing a spin.
      if (msgs.length === 0 && !abortSignal?.aborted) {
        const delay = minEmptyPollDelayMs - (Date.now() - startedAt);
        if (delay > 0) await wait(delay);
      }
    } catch (err) {
      if (abortSignal?.aborted) break;
      if (err?.isSessionExpired || err?.isStaleToken || err?.errcode === SESSION_EXPIRED_ERRCODE || err?.ret === SESSION_EXPIRED_ERRCODE) {
        pauseSession(accountId);
        wasPaused = true;
        consecutiveFailures = 0;
        aLog("error", "bot token is stale; API requests paused until refreshed or cooldown ends", { errcode: SESSION_EXPIRED_ERRCODE });
        await reportError(err);
        continue;
      }
      consecutiveFailures++;
      aLog("warn", "getUpdates failed", { count: `${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`, ...classifyFetchError(err) });
      await reportError(err);
      const backoff = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
      if (backoff) consecutiveFailures = 0;
      await wait(backoff ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
    }
  }
  aLog("info", "polling ended");
}
