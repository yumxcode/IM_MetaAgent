#!/usr/bin/env node
/**
 * 微信 iLink Bot —— 登录与自检 CLI（零外部依赖版）
 *
 * 不依赖 Claude SDK / 任何外部框架，仅依赖 Node.js 内置能力 + 本接入层（src/）。
 *
 * 用法:
 *   node weixin-login-check.mjs                # 默认：加载账号并做一次 token 自检
 *   node weixin-login-check.mjs --login        # 扫码登录（首次必用）
 *   node weixin-login-check.mjs --accounts     # 列出已登录账号
 *   node weixin-login-check.mjs --check        # 仅做 token 自检（不监听）
 *   node weixin-login-check.mjs --listen       # 自检后进入回声监听（验证收发链路）
 *   node weixin-login-check.mjs --logout <id>  # 删除指定账号凭据
 *
 * 环境变量:
 *   WEIXIN_LOG_LEVEL   日志级别 (trace/debug/info/warn/error)，默认 info
 *   WEIXIN_CHECK_TIMEOUT_MS  token 自检超时，默认 3000
 */
import { createRequire } from "node:module";

// 加载 .env（若安装了 dotenv；未安装则忽略）
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch {}

import {
  WeixinBot,
  log,
  getUpdates,
  WeixinHttpError,
  WeixinApiError,
  WeixinTimeoutError,
  SESSION_EXPIRED_ERRCODE,
} from "./src/index.mjs";

// ---------------------------------------------------------------------------
// token 自检：用一次短超时 getUpdates 探测 token 是否可用
// ---------------------------------------------------------------------------

/**
 * @typedef {"valid"|"expired"|"invalid"|"network_error"|"unknown"} CheckResult
 */

/**
 * 探测账号 token 当前是否可用。
 * 思路：发起一次很短（默认 3s）的 getUpdates 长轮询：
 *  - 返回 ret=0          → token 有效（可能带回少量积压消息）
 *  - WeixinTimeoutError  → token 有效（服务器 hold 到客户端超时，正常）
 *  - WeixinApiError      → 看 errcode：-14 = session 过期需重新登录；其他 = 鉴权/参数错误
 *  - WeixinHttpError     → 401/403 等 HTTP 层错误
 *  - 其他网络异常         → 连不通
 *
 * @param {{baseUrl:string, token:string, timeoutMs?:number}} account
 * @returns {Promise<{result:CheckResult, detail:string, raw?:object, errcode?:number}>}
 */
async function checkToken({ baseUrl, token, timeoutMs = 3000 }) {
  if (!token) return { result: "invalid", detail: "no token stored" };
  try {
    const resp = await getUpdates({
      baseUrl,
      token,
      getUpdatesBuf: "",
      timeoutMs,
    });
    const msgCount = Array.isArray(resp.msgs) ? resp.msgs.length : 0;
    return {
      result: "valid",
      detail: `token 有效（本次长轮询返回 ${msgCount} 条积压消息）`,
      raw: resp,
    };
  } catch (err) {
    if (err instanceof WeixinTimeoutError) {
      return { result: "valid", detail: "token 有效（服务器 hold 到客户端超时，无新消息）" };
    }
    if (err instanceof WeixinApiError) {
      const errcode = err.info?.errcode;
      if (errcode === SESSION_EXPIRED_ERRCODE) {
        return { result: "expired", detail: `session 已过期（errcode=${errcode}），需重新 --login`, errcode };
      }
      return { result: "invalid", detail: `业务错误 ret=${err.info?.ret} errcode=${errcode} errmsg=${err.info?.errmsg ?? ""}`, errcode };
    }
    if (err instanceof WeixinHttpError) {
      return { result: "invalid", detail: `HTTP ${err.info?.status}: ${err.info?.body ?? ""}` };
    }
    return { result: "network_error", detail: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// 子命令实现
// ---------------------------------------------------------------------------

async function cmdAccounts() {
  const bot = new WeixinBot();
  const ids = bot.listAccounts();
  if (!ids.length) {
    console.log("暂无已登录账号。运行: node weixin-login-check.mjs --login");
    return;
  }
  console.log("已登录账号：");
  for (const id of ids) {
    const info = bot.getAccountInfo(id);
    console.log(`  ${id}`);
    console.log(`    configured : ${info.configured}`);
    console.log(`    userId     : ${info.userId ?? "(none)"}`);
    console.log(`    baseUrl    : ${info.baseUrl ?? "(default)"}`);
    console.log(`    paused     : ${info.paused}`);
    console.log(`    savedAt    : ${info.savedAt ?? "(unknown)"}`);
  }
}

async function cmdLogin() {
  const bot = new WeixinBot();
  const result = await bot.login();
  console.log("\n📦 凭据已持久化，后续运行无需扫码。");
  return result;
}

async function cmdLogout(accountId) {
  if (!accountId) {
    console.error("用法: node weixin-login-check.mjs --logout <accountId>");
    process.exit(2);
  }
  const bot = new WeixinBot();
  await bot.logout(accountId);
  console.log(`🗑️  已删除账号 ${accountId}`);
}

/**
 * 对所有已登录账号（或指定账号）做 token 自检并打印结果。
 * @returns {Promise<{allValid:boolean, accountIds:string[]}>}
 */
async function cmdCheck() {
  const bot = new WeixinBot();
  const ids = bot.listAccounts();
  if (!ids.length) {
    console.error("❌ 没有已登录账号。请先运行: node weixin-login-check.mjs --login");
    process.exit(1);
  }
  const timeoutMs = Number(process.env.WEIXIN_CHECK_TIMEOUT_MS) || 3000;
  console.log(`🔍 开始自检 ${ids.length} 个账号（超时 ${timeoutMs} ms / 账号）...\n`);

  let allValid = true;
  for (const id of ids) {
    const acct = bot._account(id);
    process.stdout.write(`  ${id} ... `);
    const r = await checkToken({ baseUrl: acct.baseUrl, token: acct.token, timeoutMs });
    const icon =
      r.result === "valid" ? "✅" :
      r.result === "expired" ? "⏰" :
      r.result === "network_error" ? "🌐" : "❌";
    console.log(`${icon} [${r.result.toUpperCase()}] ${r.detail}`);
    if (r.result !== "valid") allValid = false;
  }
  console.log("");
  if (allValid) {
    console.log("🎉 所有账号 token 均有效。");
  } else {
    console.log("⚠️  存在无效账号，请按提示重新 --login。");
  }
  return { allValid, accountIds: ids };
}

/**
 * 自检通过后进入回声监听：收到任何文本消息原样回复，用于验证完整收发链路。
 * 按 Ctrl+C 退出。
 */
async function cmdListen() {
  const { accountIds } = await cmdCheck();
  const bot = new WeixinBot();
  bot.setDefaultAccount(accountIds[0]);

  bot.on("message", async (msg) => {
    const preview = msg.text ? `"${msg.text.slice(0, 40)}"` : `[媒体:${msg.itemTypes?.join(",") ?? "?"}]`;
    log.info(`📩 收到消息`, { from: msg.fromUserId, preview, type: msg.messageType });
    try {
      if (msg.text) {
        await bot.reply(msg, `🤖 回声：${msg.text}`);
      } else {
        await bot.reply(msg, `🤖 收到你的${msg.messageType ?? "消息"}（媒体已保存：${msg.mediaPath ?? "N/A"}）`);
      }
      log.info(`✅ 已回复`, { to: msg.fromUserId });
    } catch (err) {
      log.error(`回复失败`, { err: String(err) });
    }
  });

  bot.on("error", (err) => log.error(`轮询错误`, { err: String(err) }));
  bot.on("session-expired", (accountId) => {
    console.error(`\n❌ Session 过期（账号 ${accountId}）。请重新运行: node weixin-login-check.mjs --login\n`);
    process.exit(1);
  });

  console.log("\n🚀 进入回声监听模式（Ctrl+C 退出）...");
  console.log("   向该微信号发任意文本，会原样回复。\n");
  await bot.start();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`微信 iLink Bot —— 登录与自检 CLI

用法:
  node weixin-login-check.mjs                默认：加载账号并做一次 token 自检
  node weixin-login-check.mjs --login        扫码登录（首次必用）
  node weixin-login-check.mjs --accounts     列出已登录账号
  node weixin-login-check.mjs --check        仅做 token 自检（不监听）
  node weixin-login-check.mjs --listen       自检后进入回声监听（验证收发链路）
  node weixin-login-check.mjs --logout <id>  删除指定账号凭据
  node weixin-login-check.mjs --help         显示本帮助

环境变量:
  WEIXIN_LOG_LEVEL           日志级别 trace/debug/info/warn/error，默认 info
  WEIXIN_CHECK_TIMEOUT_MS    token 自检超时（毫秒），默认 3000
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  // --logout <id>
  const logoutIdx = args.indexOf("--logout");
  if (logoutIdx !== -1) {
    await cmdLogout(args[logoutIdx + 1]);
    return;
  }

  if (args.includes("--accounts")) return cmdAccounts();
  if (args.includes("--login")) return cmdLogin();
  if (args.includes("--check")) return cmdCheck();
  if (args.includes("--listen")) return cmdListen();

  // 默认行为：--check
  return cmdCheck();
}

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
