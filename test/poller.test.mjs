import test from "node:test";
import assert from "node:assert/strict";
import { startPolling } from "../src/poller.mjs";
import { WeixinApiError } from "../src/http.mjs";
import {
  pauseSession, isSessionPaused, clearSessionPause, getRemainingPauseMs,
  assertSessionActive, _resetSessionGuardForTest,
  pauseStaleToken, isStaleTokenPaused, getRemainingStaleTokenPauseMs,
  assertTokenNotStale, STALE_TOKEN_ERRCODE,
} from "../src/session-guard.mjs";

const ACCOUNT = "test-bot";
const BASE = "https://ilinkai.weixin.qq.com";

test("session guard retains old names and official stale-token aliases", () => {
  _resetSessionGuardForTest();
  assert.equal(STALE_TOKEN_ERRCODE, -14);
  assert.equal(pauseStaleToken, pauseSession);
  assert.equal(isStaleTokenPaused, isSessionPaused);
  assert.equal(getRemainingStaleTokenPauseMs, getRemainingPauseMs);
  assert.equal(assertTokenNotStale, assertSessionActive);
  pauseSession(ACCOUNT);
  assert.equal(isSessionPaused(ACCOUNT), true);
  assert.ok(getRemainingPauseMs(ACCOUNT) > 3_590_000);
  assert.throws(() => assertSessionActive(ACCOUNT), /session paused/);
  clearSessionPause(ACCOUNT);
  assert.equal(isSessionPaused(ACCOUNT), false);
});

test("thrown -14 pauses APIs and newly logged-in credentials clear cooldown", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  const tokens = [];
  const errors = [];
  const delays = [];
  let refreshed = false;
  await startPolling({
    baseUrl: BASE, token: "old", accountId: ACCOUNT, abortSignal: controller.signal,
    getUpdatesFn: async (options) => {
      tokens.push(options.token);
      if (tokens.length === 1) throw new WeixinApiError("stale", { errcode: -14 });
      assert.equal(options.token, "new");
      assert.equal(options.baseUrl, "https://ilinkai.weixin.qq.com/new");
      assert.equal(options.routeTag, "new-route");
      return { ret: 0, msgs: [{ message_id: "1" }] };
    },
    reloadCredentials: async () => ({ token: refreshed ? "new" : "old", baseUrl: refreshed ? "https://ilinkai.weixin.qq.com/new" : BASE, routeTag: refreshed ? "new-route" : "old-route" }),
    sleepFn: async (duration) => { delays.push(duration); assert.equal(isSessionPaused(ACCOUNT), true); refreshed = true; },
    onError: (error) => errors.push(error),
    onMessage: () => controller.abort(),
  });
  assert.deepEqual(tokens, ["old", "new"]);
  assert.equal(errors.length, 1);
  assert.deepEqual(delays, [5000]);
  assert.equal(isSessionPaused(ACCOUNT), false);
});

test("returned ret -14 also takes cooldown rather than generic retry backoff", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  let calls = 0;
  const delays = [];
  await startPolling({
    baseUrl: BASE, token: "same", accountId: ACCOUNT, abortSignal: controller.signal,
    getUpdatesFn: async () => { calls++; return calls === 1 ? { ret: -14, errmsg: "stale" } : { ret: 0, msgs: [{ message_id: "2" }] }; },
    sleepFn: async (duration) => { delays.push(duration); clearSessionPause(ACCOUNT); },
    onMessage: () => controller.abort(),
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [5000]);
});

test("three actual failures trigger backoff and successful polls reset it", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  const delays = [];
  let calls = 0;
  let errors = 0;
  await startPolling({
    baseUrl: BASE, accountId: ACCOUNT, abortSignal: controller.signal,
    getUpdatesFn: async () => { if (++calls <= 3) throw new Error("test failure"); return { ret: 0, msgs: [{ message_id: "1" }] }; },
    sleepFn: async (duration) => delays.push(duration),
    onError: () => errors++, onMessage: () => controller.abort(),
  });
  assert.deepEqual(delays, [2000, 2000, 30000]);
  assert.equal(errors, 3);
  assert.equal(calls, 4);
});

test("aborting an active long-poll ends normally with no error or message callback", async (t) => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  let errors = 0;
  let messages = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    return await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => { const error = new Error("stop"); error.name = "AbortError"; reject(error); }, { once: true });
      queueMicrotask(() => controller.abort());
    });
  });
  await startPolling({ baseUrl: BASE, accountId: ACCOUNT, abortSignal: controller.signal, onError: () => errors++, onMessage: () => messages++ });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(errors, 0);
  assert.equal(messages, 0);
});

test("immediately empty polls are throttled and carry the abort signal", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  let count = 0;
  const delays = [];
  await startPolling({
    baseUrl: BASE, accountId: ACCOUNT, abortSignal: controller.signal,
    getUpdatesFn: async (options) => { assert.equal(options.abortSignal, controller.signal); count++; return { ret: 0, msgs: [] }; },
    sleepFn: async (duration) => { delays.push(duration); controller.abort(); },
  });
  assert.equal(count, 1);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 0 && delays[0] <= 250);
});

test("cursor persists, server polling timeout updates, and handler failures do not break polling", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  const saved = [];
  const seen = [];
  const requests = [];
  await startPolling({
    baseUrl: BASE, accountId: ACCOUNT, abortSignal: controller.signal,
    loadSyncBuf: () => "loaded", saveSyncBuf: (cursor) => saved.push(cursor),
    getUpdatesFn: async (options) => {
      requests.push(options);
      return requests.length === 1 ? { ret: 0, get_updates_buf: "updated", longpolling_timeout_ms: 48000, msgs: [{ message_id: "first" }] } : { ret: 0, msgs: [{ message_id: "second" }] };
    },
    onMessage: (msg, accountId) => { assert.equal(accountId, ACCOUNT); seen.push(msg.message_id); if (seen.length === 1) throw new Error("test handler failed"); controller.abort(); },
    sleepFn: async () => {},
  });
  assert.deepEqual(saved, ["updated"]);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(requests[0].getUpdatesBuf, "loaded");
  assert.equal(requests[1].getUpdatesBuf, "updated");
  assert.equal(requests[1].timeoutMs, 48000);
});

test("custom paused state without a guard entry sleeps instead of spinning", async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController();
  let calls = 0;
  const delays = [];
  await startPolling({
    baseUrl: BASE, accountId: ACCOUNT, abortSignal: controller.signal, shouldPause: () => true,
    getUpdatesFn: async () => { calls++; },
    sleepFn: async (duration) => { delays.push(duration); controller.abort(); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(delays, [2000]);
});
