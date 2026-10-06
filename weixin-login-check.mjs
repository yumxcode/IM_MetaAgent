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
} from "./src/index.mjs";
import { checkAccountHealth as checkToken } from "./src/account-health.mjs";
import { installProcessGuards, installGracefulShutdown } from "./src/process-guard.mjs";

// ---------------------------------------------------------------------------
// token 自检使用 getConfig，不消费消息或修改长轮询游标。
// ---------------------------------------------------------------------------
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
  if (result.connected === false) { console.error(result.message); process.exitCode = 1; return result; }
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
    const r = await checkToken({ baseUrl: acct.baseUrl, token: acct.token, userId: bot.getAccountInfo(id)?.userId, timeoutMs });
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
    console.log("⚠️  部分账号状态未确认，请根据上面的具体结果处理。");
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
  bot.setDefaultAccount(bot.getDefaultAccount());

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
    console.error(`\n⏸️  Session 过期（账号 ${accountId}）。已进入熔断保护，暂停约 60 分钟后自动重试。`);
    console.error(`    如需立即恢复，请重新运行: node weixin-login-check.mjs --login\n`);
  });

  console.log("\n🚀 进入回声监听模式（Ctrl+C 退出）...");
  console.log("   向该微信号发任意文本，会原样回复。\n");
  installGracefulShutdown(bot);
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
  if (args.includes("--check")) { const r = await cmdCheck(); if (!r.allValid) process.exitCode = 1; return; }
  if (args.includes("--listen")) return cmdListen();

  // 默认行为：--check
  const r = await cmdCheck(); if (!r.allValid) process.exitCode = 1;
}

installProcessGuards();

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
