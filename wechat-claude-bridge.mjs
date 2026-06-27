#!/usr/bin/env node
/**
 * 微信 ↔ Claude Code Agent 桥接 Demo
 *
 * 基于完备的微信接入层（src/），展示如何用 WeixinBot 接入 AI：
 *   - 扫码登录（凭据持久化，重启免登）
 *   - 事件驱动接收消息（文本/图片/语音/文件/视频）
 *   - 自动下载入站媒体
 *   - 回复前显示"正在输入"
 *   - 调用 Claude Code Agent 生成回复
 *   - 支持 AI 主动发送媒体文件
 *
 * 用法:
 *   node wechat-claude-bridge.mjs            # 自动加载已保存凭据，开始监听
 *   node wechat-claude-bridge.mjs --login    # 强制重新扫码登录
 *   node wechat-claude-bridge.mjs --accounts  # 列出已登录账号
 *
 * 环境变量:
 *   WEIXIN_LOG_LEVEL   日志级别 (trace/debug/info/warn/error)，默认 info
 *   ANTHROPIC_API_KEY  Claude API key（也可通过 ~/.anthropic 凭证）
 */
import { createRequire } from "node:module";

// 加载 .env（可选）
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch {}

import { WeixinBot, log } from "./src/index.mjs";
import { installProcessGuards } from "./src/process-guard.mjs";

// Claude Agent SDK 是可选依赖：未安装时降级为回声模式
let queryClaude = null;
try {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  queryClaude = query;
} catch {
  log.warn("@anthropic-ai/claude-agent-sdk 未安装，将使用回声模式（原样回复用户消息）");
}

// ---------------------------------------------------------------------------
// Claude 调用：把用户文本交给 Claude Code Agent，返回最终文本
// ---------------------------------------------------------------------------

async function askClaude(userText, { mediaContext } = {}) {
  if (!queryClaude) {
    // 回声模式：用于无 Claude SDK 时的功能验证
    const prefix = mediaContext ? `[收到${mediaContext}] ` : "";
    return `${prefix}回声：${userText}`;
  }

  async function* messages() {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: userText },
    };
  }

  let result = "";
  for await (const msg of queryClaude({
    prompt: messages(),
    options: {
      model: "sonnet",
      baseTools: [{ preset: "default" }],
      deniedTools: ["AskUserQuestion"],
      cwd: process.cwd(),
      env: process.env,
      abortController: new AbortController(),
    },
  })) {
    if (msg.type === "result") result = msg.result ?? "";
  }
  return result || "（无回复）";
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const forceLogin = args.includes("--login");
  const listOnly = args.includes("--accounts");

  const bot = new WeixinBot();

  // --accounts：仅列出已登录账号
  if (listOnly) {
    const ids = bot.listAccounts();
    if (!ids.length) {
      console.log("暂无已登录账号。运行: node wechat-claude-bridge.mjs --login");
      return;
    }
    console.log("已登录账号：");
    for (const id of ids) {
      const info = bot.getAccountInfo(id);
      console.log(`  ${id}`);
      console.log(`    configured: ${info.configured}, userId: ${info.userId ?? "(none)"}, paused: ${info.paused}`);
    }
    return;
  }

  // 登录：无账号或 --login 时扫码
  const existing = bot.listAccounts();
  if (forceLogin || !existing.length) {
    await bot.login();
  } else {
    bot.setDefaultAccount(existing[0]);
    const info = bot.getAccountInfo();
    console.log(`✅ 已加载账号 ${info.accountId}（保存于 ${info.savedAt}）`);
    if (info.paused) {
      console.error(`❌ 该账号处于 session 暂停期，请稍后再试或重新登录: --login`);
      process.exit(1);
    }
  }

  // ------------------------------------------------------------------
  // 事件订阅
  // ------------------------------------------------------------------

  // 通用消息处理：文本 → Claude → 回复
  bot.on("message", async (msg) => {
    const summary = msg.text ? `"${msg.text.slice(0, 40)}"` : `[媒体:${msg.itemTypes.join(",")}]`;
    log.info(`📩 收到消息`, { from: msg.fromUserId, summary });

    // 显示"正在输入"
    const typing = await bot.typing({ to: msg.fromUserId, contextToken: msg.contextToken });
    await typing.start();
    try {
      // 构造给 Claude 的输入：文本 + 媒体上下文
      let mediaContext = null;
      if (msg.mediaPath) {
        if (msg.mediaType?.startsWith("image/")) mediaContext = "图片";
        else if (msg.mediaType?.startsWith("audio/")) mediaContext = msg.voiceText ? `语音（转写：${msg.voiceText}）` : "语音";
        else if (msg.mediaType?.startsWith("video/")) mediaContext = "视频";
        else mediaContext = `文件(${msg.fileName ?? "?"})`;
      }

      const input = mediaContext ? `${msg.text || ""}\n[用户还发送了${mediaContext}]` : msg.text;
      const reply = await askClaude(input, { mediaContext });
      await bot.reply(msg, reply);
      log.info(`✅ 已回复`, { preview: reply.slice(0, 60) });
    } catch (err) {
      log.error(`处理消息失败`, { err: String(err) });
      try {
        await bot.reply(msg, `⚠️ 处理失败：${err.message}`);
      } catch { /* 发不出去就算了 */ }
    } finally {
      await typing.stop();
    }
  });

  // 错误与 session 过期
  bot.on("error", (err) => {
    log.error(`轮询错误`, { err: String(err) });
  });
  bot.on("session-expired", (accountId) => {
    log.warn(`Session 过期，进入熔断保护`, { accountId });
    console.error(`\n⏸️  Session 过期（账号 ${accountId}）。已进入熔断保护，暂停约 60 分钟后自动重试。`);
    console.error(`    如需立即恢复，请重新运行: node wechat-claude-bridge.mjs --login\n`);
  });

  // 启动长轮询（阻塞）
  console.log("🚀 开始监听消息（Ctrl+C 退出）...\n");
  await bot.start();
}

installProcessGuards();

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
