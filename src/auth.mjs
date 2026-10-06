/**
 * 鉴权模块：QR 码登录 + 账号凭据持久化 + 多账号管理
 *
 * 覆盖完整的登录生命周期：
 *  - 获取二维码 → 终端渲染 → 长轮询扫码状态 → 过期自动刷新 → 拿到 bot_token
 *  - 凭据持久化到 ~/.weixin-bot/accounts/{accountId}.json（0600 权限）
 *  - 多账号索引（accounts.json）
 *  - 游标（get_updates_buf）持久化，支持重启续接
 *
 * 与 packages/ 下的官方插件行为对齐，但去除框架依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import {
  ACTIVE_LOGIN_TTL_MS,
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  MAX_QR_REFRESH_COUNT,
  QR_LONG_POLL_TIMEOUT_MS,
  QrCodeStatus,
} from "./constants.mjs";
import { _apiGet as apiGet, _apiPost as apiPost } from "./http.mjs";
import {
  ensureDir,
  log,
  normalizeAccountId,
  readJson,
  redactToken,
  removeFile,
  resolveStateDir,
  sleep,
  writeJson,
} from "./util.mjs";

// ---------------------------------------------------------------------------
// 状态目录布局
// ---------------------------------------------------------------------------

/**
 * 一次性自动迁移：旧目录名 openclaw-weixin → weixin-bot。
 * 在启动及运行时解析目录：旧存在且新不存在 → rename（原子操作，不丢数据）。
 */
function migrateLegacyStateDir() {
  const base = resolveStateDir();
  const oldDir = path.join(base, "openclaw-weixin");
  const newDir = path.join(base, "weixin-bot");
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      log.info(`自动迁移状态目录: openclaw-weixin → weixin-bot`);
    } catch (err) {
      log.warn(`状态目录迁移失败（将在旧目录继续运行）`, { err: String(err) });
    }
  }
}
migrateLegacyStateDir();

function stateDir() {
  migrateLegacyStateDir();
  const base = resolveStateDir();
  const newDir = path.join(base, "weixin-bot");
  const oldDir = path.join(base, "openclaw-weixin");
  // New installs must write to the canonical directory immediately. A later
  // quote-cache initialization must not change where credentials are loaded.
  return fs.existsSync(newDir) || !fs.existsSync(oldDir) ? newDir : oldDir;
}
function legacyPath(...parts) {
  return path.join(resolveStateDir(), "openclaw-weixin", ...parts);
}
function readAccountIndex(filePath) {
  const arr = readJson(filePath, []);
  return Array.isArray(arr) ? arr.filter((id) => typeof id === "string" && id.trim()) : [];
}
function accountsDir() {
  return path.join(stateDir(), "accounts");
}
function accountIndexPath() {
  return path.join(stateDir(), "accounts.json");
}
function accountFilePath(accountId) {
  return path.join(accountsDir(), `${accountId}.json`);
}
/** 游标文件路径：{accountId}.sync.json。 */
function syncBufFilePath(accountId) {
  return path.join(accountsDir(), `${accountId}.sync.json`);
}

// ---------------------------------------------------------------------------
// 账号索引（accounts.json：所有已登录账号 ID 列表）
// ---------------------------------------------------------------------------

/** 返回所有已注册的账号 ID。 */
export function listAccountIds() {
  const primary = accountIndexPath();
  const legacy = legacyPath("accounts.json");
  return [...new Set([
    ...(primary === legacy ? [] : readAccountIndex(legacy)),
    ...readAccountIndex(primary),
  ])];
}

/** 将账号 ID 加入索引（已存在则 no-op）。 */
export function registerAccountId(accountId) {
  const existing = listAccountIds();
  // If an account is still indexed only in a legacy directory, registering a
  // canonical credential must also make its canonical index self-contained.
  if (readAccountIndex(accountIndexPath()).includes(accountId)) return;
  ensureDir(stateDir());
  writeJson(accountIndexPath(), existing.includes(accountId) ? existing : [...existing, accountId], { mode: 0o644 });
}

/** 从索引移除账号。 */
export function unregisterAccountId(accountId) {
  for (const indexPath of new Set([accountIndexPath(), legacyPath("accounts.json")])) {
    const existing = readAccountIndex(indexPath);
    const filtered = existing.filter((id) => normalizeAccountId(id) !== accountId);
    if (filtered.length !== existing.length) writeJson(indexPath, filtered, { mode: 0o644 });
  }
}

// ---------------------------------------------------------------------------
// 账号凭据存储（{accountId}.json）
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AccountData
 * @property {string} token - bot_token（Bearer 鉴权用）
 * @property {string} [baseUrl] - iLink API 基础地址
 * @property {string} [userId] - 扫码用户的 ilink_user_id
 * @property {string} [accountId] - 规范化后的账号 ID（ilink_bot_id）
 * @property {string} [savedAt] - ISO 时间戳
 */

/** 加载账号凭据，不存在返回 null。 */
export function loadAccount(accountId) {
  const id = normalizeAccountId(accountId);
  return readJson(accountFilePath(id), null) ?? readJson(legacyPath("accounts", `${id}.json`), null);
}

/** 保存账号凭据（合并写入）。 */
export function saveAccount(accountId, data) {
  const id = normalizeAccountId(accountId);
  const existing = loadAccount(id) ?? {};
  const merged = {
    ...existing,
    ...data,
    savedAt: new Date().toISOString(),
  };
  ensureDir(accountsDir());
  writeJson(accountFilePath(id), merged, { mode: 0o600 });
  registerAccountId(id);
  return merged;
}

/** 删除账号凭据 + 游标 + 索引记录。 */
export function deleteAccount(accountId) {
  const id = normalizeAccountId(accountId);
  removeFile(accountFilePath(id));
  removeFile(syncBufFilePath(id));
  // Both-directory compatibility must not resurrect a logged-out credential.
  removeFile(legacyPath("accounts", `${id}.json`));
  removeFile(legacyPath("accounts", `${id}.sync.json`));
  unregisterAccountId(id);
}

/**
 * 解析账号为可直接用于 API 调用的运行时配置。
 * 若传入 token，则覆盖存储的 token（便于运行时重新登录）。
 */
export function resolveAccount({ accountId, token, baseUrl, cdnBaseUrl } = {}) {
  if (!accountId) throw new Error("accountId is required");
  const id = normalizeAccountId(accountId);
  const stored = loadAccount(id) ?? {};
  const resolvedToken = (token ?? stored.token)?.trim() || undefined;
  const resolvedBaseUrl = (baseUrl ?? stored.baseUrl)?.trim() || DEFAULT_BASE_URL;
  return {
    accountId: id,
    token: resolvedToken,
    baseUrl: resolvedBaseUrl,
    cdnBaseUrl: cdnBaseUrl || "https://novac2c.cdn.weixin.qq.com/c2c",
    configured: Boolean(resolvedToken),
  };
}

// ---------------------------------------------------------------------------
// 游标（get_updates_buf）持久化
// ---------------------------------------------------------------------------

/** 加载持久化的 get_updates_buf，不存在返回 undefined。 */
export function loadSyncBuf(accountId) {
  const id = normalizeAccountId(accountId);
  const data = readJson(syncBufFilePath(id), null) ?? readJson(legacyPath("accounts", `${id}.sync.json`), null);
  return data?.get_updates_buf;
}

/** 持久化 get_updates_buf。 */
export function saveSyncBuf(accountId, getUpdatesBuf) {
  const id = normalizeAccountId(accountId);
  ensureDir(accountsDir());
  writeJson(syncBufFilePath(id), { get_updates_buf: getUpdatesBuf }, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// QR 码登录流程
// ---------------------------------------------------------------------------

/**
 * 活跃登录会话（内存，进程级）。
 * 用于 startLogin / waitForLogin 两阶段登录的分段：先 start 拿二维码，
 * 再 wait 轮询状态。同一 sessionKey 5 分钟内可复用二维码。
 */
const activeLogins = new Map(); // sessionKey -> { qrcode, qrcodeUrl, startedAt, status, botToken? }

function purgeExpiredLogins() {
  const now = Date.now();
  for (const [k, v] of activeLogins) {
    if (now - v.startedAt >= ACTIVE_LOGIN_TTL_MS) activeLogins.delete(k);
  }
}

const MAX_VERIFY_ATTEMPTS = 3;
const MAX_LOGIN_REDIRECTS = 5;

/** Credential-bearing redirects may only target Tencent's iLink HTTPS hosts. */
function validateServerBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid login server URL");
  const raw = value.trim();
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") ||
      !(url.hostname === "ilinkai.weixin.qq.com" || /^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname))) {
    throw new Error("invalid login server URL");
  }
  return url.origin;
}

/** Avoid including response bodies, tokens, QR identifiers, or pairing codes in errors. */
function safeLoginError(err) {
  if (Number.isInteger(err?.status)) return `微信接口返回 HTTP ${err.status}。`;
  if (err?.name === "WeixinTimeoutError" || err?.name === "AbortError") return "请求超时或已取消。";
  return "请求失败，请检查网络或重新登录。";
}

function localAccountSnapshot() {
  const entries = [];
  const seen = new Set();
  const ids = listAccountIds();
  for (let i = ids.length - 1; i >= 0 && entries.length < 10; i--) {
    const accountId = normalizeAccountId(ids[i]);
    if (!/^[A-Za-z0-9_.-]+$/.test(accountId)) continue;
    const data = loadAccount(accountId);
    const token = typeof data?.token === "string" ? data.token.trim() : "";
    if (!token || seen.has(token)) continue;
    seen.add(token);
    entries.push({ ...data, accountId, token });
  }
  return entries;
}

async function fetchQRCode(apiBaseUrl, botType, routeTag, signal) {
  const accounts = localAccountSnapshot();
  const qr = await apiPost({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: accounts.map((account) => account.token) },
    injectBaseInfo: false,
    allowApiError: true,
    label: "fetchQRCode",
    routeTag,
    signal,
  });
  if ((qr.ret !== undefined && qr.ret !== 0) || (qr.errcode !== undefined && qr.errcode !== 0) ||
      typeof qr.qrcode !== "string" || !qr.qrcode.trim() ||
      typeof qr.qrcode_img_content !== "string" || !qr.qrcode_img_content.trim()) {
    throw new Error("invalid QR response");
  }
  return { ...qr, accounts };
}

async function pollQRStatus(apiBaseUrl, qrcode, routeTag, verifyCode, timeoutMs, signal) {
  let query = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) query += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await apiGet({
      baseUrl: apiBaseUrl,
      path: query,
      timeoutMs: Math.min(QR_LONG_POLL_TIMEOUT_MS, timeoutMs),
      label: "pollQRStatus",
      routeTag,
      signal,
    });
  } catch (err) {
    if (!signal?.aborted && (err?.name === "WeixinTimeoutError" || err?.name === "AbortError" ||
        err?.status >= 500 || err?.name === "WeixinNetworkError" || err?.name === "TypeError")) {
      log.debug("QR poll interrupted; retrying until login deadline");
      return { status: QrCodeStatus.WAIT };
    }
    throw err;
  }
}

async function requestVerifyCode(onVerifyCode, info, remainingMs, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(remainingMs, 1));
  let rl;
  try {
    const timeout = new Promise((_, reject) => {
      if (controller.signal.aborted) return reject(new Error("verify input timeout"));
      controller.signal.addEventListener("abort", () => reject(new Error("verify input timeout")), { once: true });
    });
    let response;
    if (onVerifyCode) {
      response = Promise.resolve().then(() => onVerifyCode({ ...info, signal: controller.signal }));
    } else {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      response = rl.question(info.retry ? "配对码不匹配，请重新输入微信显示的数字：" : "请输入手机微信显示的数字：", { signal: controller.signal });
    }
    return await Promise.race([response, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    rl?.close();
  }
}

/**
 * 终端渲染二维码。
 * 优先尝试 qrcode-terminal（若已安装），失败则回退到打印 URL。
 * @param {string} qrcodeUrl - 二维码内容（通常是 data: URL 或 https URL）
 */
export async function renderQrCode(qrcodeUrl) {
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise((resolve) => {
      qrterm.default.generate(qrcodeUrl, { small: true }, (qr) => {
        console.log(qr);
        resolve();
      });
    });
    return true;
  } catch {
    console.log(`  二维码链接: ${qrcodeUrl}\n`);
    return false;
  }
}

/**
 * 一阶段：发起登录，获取二维码。
 * 返回 sessionKey，需传给 waitForLogin 继续轮询。
 *
 * @returns {Promise<{qrcodeUrl?:string, sessionKey:string, message:string}>}
 */
export async function startLogin({ apiBaseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE, sessionKey, accountId, routeTag, force = false, signal } = {}) {
  purgeExpiredLogins();
  const key = sessionKey || accountId || randomUUID();
  const existing = activeLogins.get(key);
  if (!force && existing && Date.now() - existing.startedAt < ACTIVE_LOGIN_TTL_MS && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, sessionKey: key, message: "二维码已就绪，请使用微信扫描。" };
  }
  try {
    const qr = await fetchQRCode(apiBaseUrl, botType, routeTag, signal);
    activeLogins.set(key, {
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      apiBaseUrl,
      currentApiBaseUrl: apiBaseUrl,
      accounts: qr.accounts,
      requestedAccountId: accountId ? normalizeAccountId(accountId) : undefined,
      verifyAttempts: 0,
      redirectCount: 0,
      refreshCount: 1,
    });
    log.info("QR code received");
    return { qrcodeUrl: qr.qrcode_img_content, sessionKey: key, message: "使用微信扫描以下二维码，以完成连接。" };
  } catch (err) {
    activeLogins.delete(key);
    return { sessionKey: key, message: `登录发起失败：${safeLoginError(err)}` };
  }
}

/**
 * Poll a login session. Library callers can supply an async onVerifyCode callback.
 * Without a TTY, pairing requests return requiresVerifyCode and remain resumable
 * via waitForLogin({ sessionKey, verifyCode }) instead of reading stdin forever.
 */
export async function waitForLogin({ sessionKey, apiBaseUrl, botType = DEFAULT_BOT_TYPE, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS, routeTag, onStatus, onRender = renderQrCode, onVerifyCode, verifyCode, persist = true, signal, pollIntervalMs = 1000 } = {}) {
  const active = activeLogins.get(sessionKey);
  if (!active) return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  if (Date.now() - active.startedAt >= ACTIVE_LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }
  if (verifyCode !== undefined) {
    if (active.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      activeLogins.delete(sessionKey);
      return { connected: false, message: "配对码尝试次数过多，请重新扫码。" };
    }
    const code = String(verifyCode).trim();
    if (!/^\d{1,16}$/.test(code)) return { connected: false, requiresVerifyCode: true, sessionKey, message: "请输入手机微信显示的数字配对码。" };
    active.pendingVerifyCode = code;
    active.verifyAttempts++;
  }
  const deadline = Date.now() + Math.max(Number(timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS, 1000);
  let scannedNotified = false;
  const stop = (message) => {
    activeLogins.delete(sessionKey);
    return { connected: false, message };
  };
  const refresh = async () => {
    active.refreshCount++;
    if (active.refreshCount > MAX_QR_REFRESH_COUNT) return false;
    const qr = await fetchQRCode(active.apiBaseUrl || apiBaseUrl || DEFAULT_BASE_URL, botType, routeTag, signal);
    active.qrcode = qr.qrcode;
    active.qrcodeUrl = qr.qrcode_img_content;
    active.startedAt = Date.now();
    active.currentApiBaseUrl = active.apiBaseUrl || apiBaseUrl || DEFAULT_BASE_URL;
    active.accounts = qr.accounts;
    active.pendingVerifyCode = undefined;
    active.verifyAttempts = 0;
    active.redirectCount = 0;
    scannedNotified = false;
    await onRender(active.qrcodeUrl);
    return true;
  };

  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const currentBaseUrl = active.currentApiBaseUrl || apiBaseUrl || DEFAULT_BASE_URL;
      const response = await pollQRStatus(currentBaseUrl, active.qrcode, routeTag, active.pendingVerifyCode, deadline - Date.now(), signal);
      if ((response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)) {
        return stop("登录失败：微信返回了错误状态，请重新登录。");
      }
      active.status = response.status;
      await onStatus?.(response.status, response);
      switch (response.status) {
        case QrCodeStatus.WAIT:
          break;
        case QrCodeStatus.SCANED:
          active.pendingVerifyCode = undefined;
          if (!scannedNotified) {
            log.info("已扫码，请在微信端确认");
            scannedNotified = true;
          }
          break;
        case "need_verifycode": {
          if (active.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return stop("配对码多次不匹配，登录已停止，请重新扫码。");
          if (!onVerifyCode && !(process.stdin.isTTY && process.stdout.isTTY)) {
            return { connected: false, requiresVerifyCode: true, sessionKey, message: "登录需要手机微信显示的数字配对码。请在交互终端登录，或提供 onVerifyCode 回调，再通过 waitForLogin({ sessionKey, verifyCode }) 继续。" };
          }
          const retry = Boolean(active.pendingVerifyCode);
          const code = await requestVerifyCode(onVerifyCode, { sessionKey, attempt: active.verifyAttempts + 1, retry, status: response.status }, deadline - Date.now(), signal);
          if (code === undefined || code === null) return stop("配对码输入已取消，请重新登录。");
          active.verifyAttempts++;
          const trimmed = String(code).trim();
          if (!/^\d{1,16}$/.test(trimmed)) {
            active.pendingVerifyCode = undefined;
            if (active.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return stop("配对码输入无效，登录已停止，请重新扫码。");
            continue;
          }
          active.pendingVerifyCode = trimmed;
          continue;
        }
        case QrCodeStatus.EXPIRED:
        case "verify_code_blocked":
          if (!(await refresh())) return stop(response.status === "verify_code_blocked" ? "多次输入错误，登录已停止，请稍后重新扫码。" : "二维码多次过期，登录已停止，请重新扫码。");
          continue;
        case "scaned_but_redirect":
          if (++active.redirectCount > MAX_LOGIN_REDIRECTS) return stop("登录重定向次数过多，请重新扫码。");
          if (!response.redirect_host) return stop("登录失败：微信未提供重定向地址。");
          active.currentApiBaseUrl = validateServerBaseUrl(response.redirect_host);
          continue;
        case "binded_redirect": {
          let candidates = active.accounts || [];
          const responseId = response.ilink_bot_id ? normalizeAccountId(response.ilink_bot_id) : undefined;
          if (responseId) candidates = candidates.filter((account) => account.accountId === responseId);
          if (response.bot_token) candidates = candidates.filter((account) => account.token === response.bot_token.trim());
          if (active.requestedAccountId) candidates = candidates.filter((account) => account.accountId === active.requestedAccountId);
          if (candidates.length !== 1) return stop("微信提示已绑定，但无法对应本地有效凭据。请指定账号或重新扫码绑定。");
          const saved = loadAccount(candidates[0].accountId);
          if (!saved || typeof saved.token !== "string" || saved.token.trim() !== candidates[0].token) return stop("微信提示已绑定，但本地凭据已失效或缺失，请重新登录。");
          const effectiveBaseUrl = response.baseurl || (currentBaseUrl !== active.apiBaseUrl ? currentBaseUrl : saved.baseUrl || currentBaseUrl);
          const baseUrl = validateServerBaseUrl(effectiveBaseUrl);
          activeLogins.delete(sessionKey);
          if (persist && currentBaseUrl !== active.apiBaseUrl && saved.baseUrl !== baseUrl) saveAccount(candidates[0].accountId, { baseUrl });
          return { connected: true, alreadyConnected: true, accountId: candidates[0].accountId, token: saved.token.trim(), baseUrl, userId: saved.userId, message: "✅ 此微信账号已连接，已复用本地登录凭据。" };
        }
        case QrCodeStatus.CONFIRMED: {
          const token = typeof response.bot_token === "string" ? response.bot_token.trim() : "";
          const accountId = normalizeAccountId(response.ilink_bot_id);
          if (!token || !accountId || !/^[A-Za-z0-9_.-]+$/.test(accountId)) return stop("登录失败：微信未返回完整的账号 ID 和登录凭据，请重新扫码。");
          const baseUrl = validateServerBaseUrl(response.baseurl || currentBaseUrl);
          activeLogins.delete(sessionKey);
          if (persist) saveAccount(accountId, { token, baseUrl, userId: response.ilink_user_id, accountId });
          log.info("Login confirmed", { accountId });
          return { connected: true, accountId, token, baseUrl, userId: response.ilink_user_id, message: "✅ 与微信连接成功！" };
        }
        default:
          return stop("登录失败：微信返回了未知登录状态，请稍后重试。");
      }
      await sleep(Math.min(Math.max(pollIntervalMs, 0), Math.max(deadline - Date.now(), 0)), signal);
    } catch (err) {
      return stop(`登录失败：${safeLoginError(err)}`);
    }
  }
  return stop(signal?.aborted ? "登录已取消。" : "登录超时，请重试。");
}

/** One-step login, including QR refresh and optional pairing-code callback. */
export async function login(opts = {}) {
  const apiBaseUrl = opts.apiBaseUrl || DEFAULT_BASE_URL;
  const onRender = opts.onRender || renderQrCode;
  console.log("\n🔐 开始微信扫码登录...\n");
  const start = await startLogin({ ...opts, apiBaseUrl });
  if (!start.qrcodeUrl) throw new Error(start.message);
  await onRender(start.qrcodeUrl);
  const result = await waitForLogin({ ...opts, sessionKey: start.sessionKey, apiBaseUrl, onRender });
  if (!result.connected) {
    const error = new Error(result.message);
    error.requiresVerifyCode = result.requiresVerifyCode;
    error.sessionKey = result.sessionKey;
    throw error;
  }
  console.log(`\n${result.message}`);
  console.log(`  Account ID : ${result.accountId}`);
  console.log(`  Base URL   : ${result.baseUrl}`);
  return result;
}

/** 暴露内部路径解析，供测试和工具使用。 */
export const _paths = {
  stateDir,
  accountsDir,
  accountFilePath,
  syncBufFilePath,
  accountIndexPath,
};
