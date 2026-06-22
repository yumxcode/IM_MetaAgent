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

import {
  ACTIVE_LOGIN_TTL_MS,
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  MAX_QR_REFRESH_COUNT,
  QR_LONG_POLL_TIMEOUT_MS,
  QrCodeStatus,
} from "./constants.mjs";
import { _apiGet as apiGet } from "./http.mjs";
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
 * 启动时执行一次：旧存在且新不存在 → rename（原子操作，不丢数据）。
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
  const base = resolveStateDir();
  const newDir = path.join(base, "weixin-bot");
  return fs.existsSync(newDir) ? newDir : path.join(base, "openclaw-weixin");
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
  const arr = readJson(accountIndexPath(), []);
  return Array.isArray(arr) ? arr.filter((id) => typeof id === "string" && id.trim()) : [];
}

/** 将账号 ID 加入索引（已存在则 no-op）。 */
export function registerAccountId(accountId) {
  const existing = listAccountIds();
  if (existing.includes(accountId)) return;
  ensureDir(stateDir());
  writeJson(accountIndexPath(), [...existing, accountId], { mode: 0o644 });
}

/** 从索引移除账号。 */
export function unregisterAccountId(accountId) {
  const existing = listAccountIds();
  if (!existing.includes(accountId)) return;
  writeJson(accountIndexPath(), existing.filter((id) => id !== accountId), { mode: 0o644 });
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
  return readJson(accountFilePath(id), null);
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
  const data = readJson(syncBufFilePath(id), null);
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

async function fetchQRCode(apiBaseUrl, botType, routeTag) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  log.info(`Fetching QR code`, { url: `(ilink)` });
  const res = await fetch(url.toString(), { headers: routeTag ? { SKRouteTag: String(routeTag) } : {} });
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${res.status} ${res.statusText} body=${body}`);
  }
  return res.json();
}

async function pollQRStatus(apiBaseUrl, qrcode, routeTag) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const headers = { "iLink-App-ClientVersion": "1" };
  if (routeTag) headers.SKRouteTag = String(routeTag);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    const raw = await res.text();
    if (!res.ok) throw new Error(`Failed to poll QR status: ${res.status} ${res.statusText} body=${raw}`);
    return JSON.parse(raw);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      log.debug(`pollQRStatus: client timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
      return { status: QrCodeStatus.WAIT };
    }
    throw err;
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
export async function startLogin({ apiBaseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE, sessionKey, routeTag } = {}) {
  purgeExpiredLogins();
  const key = sessionKey || cryptoRandomKey();

  const existing = activeLogins.get(key);
  if (existing && Date.now() - existing.startedAt < ACTIVE_LOGIN_TTL_MS && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, sessionKey: key, message: "二维码已就绪，请使用微信扫描。" };
  }

  try {
    const qr = await fetchQRCode(apiBaseUrl, botType, routeTag);
    log.info(`QR code received`, { qrcode: redactToken(qr.qrcode), imgLen: qr.qrcode_img_content?.length ?? 0 });
    activeLogins.set(key, {
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
    });
    return { qrcodeUrl: qr.qrcode_img_content, sessionKey: key, message: "使用微信扫描以下二维码，以完成连接。" };
  } catch (err) {
    log.error(`startLogin failed`, { err: String(err) });
    return { sessionKey: key, message: `Failed to start login: ${String(err)}` };
  }
}

function cryptoRandomKey() {
  // 不引入 node:crypto 顶层依赖以保持文件聚焦；用 Math + Date 足够做 session key
  return `login-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 二阶段：轮询扫码状态直到 confirmed / 超时。
 * confirmed 时自动持久化账号凭据。
 *
 * @returns {Promise<{connected:boolean, accountId?:string, baseUrl?:string, userId?:string, message:string}>}
 */
export async function waitForLogin({ sessionKey, apiBaseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS, routeTag, onStatus, persist = true } = {}) {
  let active = activeLogins.get(sessionKey);
  if (!active) {
    return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  }
  if (Date.now() - active.startedAt >= ACTIVE_LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }

  const deadline = Date.now() + Math.max(timeoutMs, 1000);
  let refreshCount = 1;
  let scannedNotified = false;

  log.info(`Polling QR code status...`);
  while (Date.now() < deadline) {
    let statusResp;
    try {
      statusResp = await pollQRStatus(apiBaseUrl, active.qrcode, routeTag);
    } catch (err) {
      log.error(`Error polling QR status`, { err: String(err) });
      activeLogins.delete(sessionKey);
      return { connected: false, message: `登录失败: ${String(err)}` };
    }
    active.status = statusResp.status;
    onStatus?.(statusResp.status, statusResp);

    switch (statusResp.status) {
      case QrCodeStatus.WAIT:
        break;
      case QrCodeStatus.SCANED:
        if (!scannedNotified) {
          console.log("\n👀 已扫码，请在微信端确认...");
          scannedNotified = true;
        }
        break;
      case QrCodeStatus.EXPIRED: {
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: "登录超时：二维码多次过期，请重新开始登录流程。" };
        }
        console.log(`\n⏳ 二维码已过期，正在刷新...(${refreshCount}/${MAX_QR_REFRESH_COUNT})`);
        try {
          const qr = await fetchQRCode(apiBaseUrl, botType, routeTag);
          active.qrcode = qr.qrcode;
          active.qrcodeUrl = qr.qrcode_img_content;
          active.startedAt = Date.now();
          scannedNotified = false;
          console.log("🔄 新二维码已生成，请重新扫描\n");
          await renderQrCode(qr.qrcode_img_content);
        } catch (refreshErr) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: `刷新二维码失败: ${String(refreshErr)}` };
        }
        break;
      }
      case QrCodeStatus.CONFIRMED: {
        if (!statusResp.ilink_bot_id) {
          activeLogins.delete(sessionKey);
          return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        activeLogins.delete(sessionKey);
        const accountId = normalizeAccountId(statusResp.ilink_bot_id);
        log.info(`Login confirmed`, { accountId, userId: redactToken(statusResp.ilink_user_id) });

        if (persist) {
          saveAccount(accountId, {
            token: statusResp.bot_token,
            baseUrl: statusResp.baseurl,
            userId: statusResp.ilink_user_id,
            accountId,
          });
        }
        return {
          connected: true,
          accountId,
          token: statusResp.bot_token,
          baseUrl: statusResp.baseurl,
          userId: statusResp.ilink_user_id,
          message: "✅ 与微信连接成功！",
        };
      }
    }
    await sleep(1000);
  }

  activeLogins.delete(sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}

/**
 * 便捷一站式登录：start + 渲染 + wait。
 *
 * @param {object} opts
 * @param {function} [opts.onRender] - 自定义二维码渲染，默认终端渲染
 * @param {function} [opts.onStatus] - 状态回调 (status, resp) => void
 */
export async function login(opts = {}) {
  const {
    apiBaseUrl = DEFAULT_BASE_URL,
    botType = DEFAULT_BOT_TYPE,
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    routeTag,
    onRender = renderQrCode,
    onStatus,
    persist = true,
  } = opts;

  console.log("\n🔐 开始微信扫码登录...\n");
  const start = await startLogin({ apiBaseUrl, botType, routeTag });
  if (!start.qrcodeUrl) {
    throw new Error(start.message);
  }
  console.log("📱 请用微信扫描以下二维码：\n");
  await onRender(start.qrcodeUrl);
  console.log("\n⏳ 等待扫码...\n");

  const result = await waitForLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl,
    botType,
    timeoutMs,
    routeTag,
    onStatus,
    persist,
  });

  if (!result.connected) {
    throw new Error(result.message);
  }
  console.log(`\n${result.message}`);
  console.log(`  Account ID : ${result.accountId}`);
  console.log(`  Base URL   : ${result.baseUrl ?? apiBaseUrl}`);
  if (result.userId) console.log(`  User ID    : ${redactToken(result.userId)}`);
  console.log("");
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
