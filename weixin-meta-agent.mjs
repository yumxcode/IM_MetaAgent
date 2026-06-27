#!/usr/bin/env node
/**
 * 微信 ↔ meta-agent 桥接
 *
 * 场景：在微信上发消息给本账号 → 调用本地 meta-agent CLI 执行任务 →
 *       把 meta-agent 的输出以微信消息返回。
 *
 * 项目概念：
 *   - 每个项目 = 一个固定文件夹（meta-agent 的 workspace）
 *   - 不一定是 git 项目（可 clone / 手动创建 / 已有目录）
 *   - 每个项目绑定独立 session（切回去能恢复上下文）
 *   - 项目池按微信 Bot 账号隔离
 *
 * 触发规则（可配置）：
 *   - 私聊：默认响应所有文本消息
 *   - 群聊：默认需以触发前缀（默认 "/"）开头
 *   - /p 系列指令：私聊和群聊均识别（元指令，不走群聊前缀）
 *
 * 用法:
 *   node weixin-meta-agent.mjs --login        首次扫码登录
 *   node weixin-meta-agent.mjs --check        自检 meta-agent CLI + 打印配置
 *   node weixin-meta-agent.mjs                加载账号并开始监听（默认）
 *   node weixin-meta-agent.mjs --accounts     列出已登录账号
 *
 * 环境变量（建议放 .env）:
 *   # ---- meta-agent 配置 ----
 *   META_AGENT_MODE          simple_auto|auto|detect|agentic|campaign|robotics，默认 simple_auto
 *                            （simple_auto = 简单场景轻量自主；用 /goal <目标> 切换为 auto 完整自主）
 *   META_AGENT_MAX_TURNS     最大轮数，默认 30
 *   META_AGENT_TIMEOUT_MS    单任务超时，默认 0=不限
 *   META_AGENT_CLONE_TIMEOUT_MS  git clone 超时，默认 600000（10 min）
 *   META_AGENT_MAX_CONCURRENT    最大并发任务数，默认 2（超过回复"系统繁忙"）
 *
 *   # ---- 触发与权限 ----
 *   WEIXIN_TRIGGER_PREFIX    群聊触发前缀，默认 "/"
 *   WEIXIN_GROUP_TRIGGER     群聊响应策略 off|prefix|all，默认 prefix
 *   WEIXIN_ALLOW_FROM        白名单 fromUserId，逗号分隔；留空=不限
 *
 *   # ---- 通用 ----
 *   WEIXIN_LOG_LEVEL         日志级别，默认 info
 *
 * ⚠️ 安全提示：
 *   meta-agent 在 workspace 内可读写文件、执行 shell 命令。微信触发时务必
 *   配置 WEIXIN_ALLOW_FROM 白名单，避免任意微信用户控制你的本地 agent。
 */
import { createRequire } from "node:module";
import { exec } from "node:child_process";

const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch {}

import path from "node:path";
import fs from "node:fs";
import { WeixinBot, log } from "./src/index.mjs";
import { resolveStateDir, readJson, writeJson, ensureDir } from "./src/util.mjs";
import { checkMetaAgent, runMetaAgent } from "./src/meta-agent-bridge.mjs";
import { installProcessGuards } from "./src/process-guard.mjs";

// ---------------------------------------------------------------------------
// 状态目录（与 auth.mjs 一致：优先 weixin-bot，回退 openclaw-weixin）
// ---------------------------------------------------------------------------
function stateSubDir() {
  const base = resolveStateDir();
  return fs.existsSync(path.join(base, "weixin-bot"))
    ? path.join(base, "weixin-bot")
    : path.join(base, "openclaw-weixin");
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const CFG = {
  // meta-agent
  mode: process.env.META_AGENT_MODE || "simple_auto",
  maxTurns: Number(process.env.META_AGENT_MAX_TURNS) || 30,
  timeoutMs: Number(process.env.META_AGENT_TIMEOUT_MS) || 0,
  cloneTimeoutMs: Number(process.env.META_AGENT_CLONE_TIMEOUT_MS) || 600_000,
  maxConcurrent: Number(process.env.META_AGENT_MAX_CONCURRENT) || 2,

  // 触发与权限
  triggerPrefix: process.env.WEIXIN_TRIGGER_PREFIX ?? "/",
  groupTrigger: process.env.WEIXIN_GROUP_TRIGGER || "prefix",
  allowFrom: (process.env.WEIXIN_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// 持久化存储
// ---------------------------------------------------------------------------

const STATE_DIR = stateSubDir();
const PROJECTS_DIR = path.join(STATE_DIR, "projects");
const PROJECTS_FILE = path.join(STATE_DIR, "projects.json");
const SESSIONS_FILE = path.join(STATE_DIR, "meta-agent-sessions.json");

// ---- projects.json: { "wxAccountId/projectId": {id,name,path,gitUrl,isTemp,...} } ----
const _projects = readJson(PROJECTS_FILE, {}) || {};
function _persistProjects() { writeJson(PROJECTS_FILE, _projects, { mode: 0o600 }); }

const projectStore = {
  /** 列出某微信号的所有项目 */
  list(wxAccountId) {
    const prefix = `${wxAccountId}/`;
    return Object.entries(_projects)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  },
  /** 获取单个项目 */
  get(wxAccountId, projectId) {
    return _projects[`${wxAccountId}/${projectId}`] ?? null;
  },
  /** 创建/更新项目 */
  save(p) {
    _projects[`${p.wxAccountId}/${p.id}`] = p;
    _persistProjects();
    return p;
  },
  /** 删除项目记录 */
  remove(wxAccountId, projectId) {
    const key = `${wxAccountId}/${projectId}`;
    const p = _projects[key];
    delete _projects[key];
    _persistProjects();
    return p;
  },
  /** 项目目录根（按微信账号隔离） */
  projectsRootFor(wxAccountId) {
    return path.join(PROJECTS_DIR, wxAccountId);
  },
};

// ---- meta-agent-sessions.json ----
// 新格式: { fromUserId: { currentProject: "xxx", sessions: { "projectId": "sessionId" } } }
// 旧格式: { fromUserId: "sessionId" } → 自动迁移
const _rawSessions = readJson(SESSIONS_FILE, {}) || {};
const _userState = new Map();
for (const [userId, val] of Object.entries(_rawSessions)) {
  if (typeof val === "string") {
    // 旧格式迁移：关联到 _default 项目
    _userState.set(userId, { currentProject: null, sessions: {} });
  } else if (val && typeof val === "object") {
    _userState.set(userId, val);
  }
}
function _persistSessions() {
  writeJson(SESSIONS_FILE, Object.fromEntries(_userState), { mode: 0o600 });
}

const sessionStore = {
  _get(userId) {
    if (!_userState.has(userId)) _userState.set(userId, { currentProject: null, sessions: {} });
    return _userState.get(userId);
  },
  getCurrentProject(userId) { return this._get(userId).currentProject; },
  setCurrentProject(userId, projectId) {
    this._get(userId).currentProject = projectId; _persistSessions();
  },
  getSession(userId, projectId) { return this._get(userId).sessions[projectId] ?? null; },
  setSession(userId, projectId, sessionId) {
    this._get(userId).sessions[projectId] = sessionId; _persistSessions();
  },
  clearSession(userId, projectId) {
    delete this._get(userId).sessions[projectId];
    const st = this._get(userId);
    if (st.currentProject === projectId) st.currentProject = null;
    _persistSessions();
  },
};

/**
 * 按「微信账号」分层构造 meta-agent session 持久化目录。
 * 结构：{STATE_DIR}/meta-agent-sessions/{wxAccountId}/
 */
function resolveSessionDir(accountId) {
  const dir = path.join(STATE_DIR, "meta-agent-sessions", accountId);
  ensureDir(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 触发判断
// ---------------------------------------------------------------------------

/**
 * @returns {{action:"clear"|"project"|"respond"|"goal"|"ignore", subcmd?, args?, prompt?}}
 */
function parseTrigger(msg) {
  const raw = msg.text?.trim();

  // /clear: 最高优先级
  if (raw === "/clear") return { action: "clear" };

  // /p 指令: 元指令，私聊群聊均识别（在群聊前缀检测之前）
  if (raw === "/p" || raw?.startsWith("/p ")) {
    const rest = raw === "/p" ? "" : raw.slice(3).trim();
    const parts = rest.split(/\s+/);
    const sub = parts[0] || "";
    const args = parts.slice(1);
    return { action: "project", subcmd: sub, args };
  }

  // /goal 指令: 用 auto 完整自主模式执行复杂目标（私聊群聊均识别）
  if (raw === "/goal" || raw?.startsWith("/goal ")) {
    const goalPrompt = raw === "/goal" ? "" : raw.slice(6).trim();
    return { action: "goal", prompt: goalPrompt };
  }

  // 白名单
  if (CFG.allowFrom.length && !CFG.allowFrom.includes(msg.fromUserId)) {
    return { action: "ignore" };
  }
  if (!raw) return { action: "ignore" };

  const isGroup = Boolean(msg.groupId);
  if (!isGroup) return { action: "respond", prompt: raw };

  switch (CFG.groupTrigger) {
    case "off": return { action: "ignore" };
    case "all": return { action: "respond", prompt: raw };
    case "prefix":
    default:
      if (!raw.startsWith(CFG.triggerPrefix)) return { action: "ignore" };
      const prompt = raw.slice(CFG.triggerPrefix.length).replace(/^@\S+\s*/, "").trim();
      return { action: prompt ? "respond" : "ignore", prompt };
  }
}

// ---------------------------------------------------------------------------
// 项目指令处理
// ---------------------------------------------------------------------------

const PROJECT_COMMANDS = `/p 项目管理指令:
  /p                    查看当前项目
  /p list               列出所有项目
  /p new <名称>         创建空项目并切换
  /p clone <url> [名称]  clone git 项目并切换
  /p <名称>             切换到指定项目（恢复其会话）
  /p rm <名称>          删除项目（代码 + 会话）`;

async function handleProjectCommand(bot, msg, subcmd, args) {
  const wxAcct = msg.accountId;
  const from = msg.fromUserId;
  const projRoot = projectStore.projectsRootFor(wxAcct);
  ensureDir(projRoot);

  // 无子命令：查看当前项目
  if (!subcmd) {
    const curId = sessionStore.getCurrentProject(from);
    const proj = curId ? projectStore.get(wxAcct, curId) : null;
    if (!proj) {
      await bot.reply(msg, "📂 当前无活跃项目。\n\n" + PROJECT_COMMANDS);
    } else {
      const sid = sessionStore.getSession(from, proj.id);
      await bot.reply(msg,
        `📂 当前项目: ${proj.name}\n` +
        `   路径: ${proj.path}\n` +
        `   来源: ${proj.gitUrl ? proj.gitUrl : proj.isTemp ? "(临时)" : "(本地创建)"}\n` +
        `   会话: ${sid ? sid.slice(0, 12) + "…" : "(无)"}`);
    }
    return;
  }

  switch (subcmd) {
    case "list":
    case "ls": {
      const list = projectStore.list(wxAcct);
      if (!list.length) {
        await bot.reply(msg, "📂 暂无项目。用 `/p new <名称>` 或 `/p clone <url>` 创建。");
        return;
      }
      const curId = sessionStore.getCurrentProject(from);
      const lines = list.map((p) =>
        `  ${p.id === curId ? "▶" : " "} ${p.name}` +
        `${p.gitUrl ? ` [git]` : ""}${p.isTemp ? " [临时]" : ""}`
      );
      await bot.reply(msg, `📂 项目列表 (${list.length}):\n${lines.join("\n")}`);
      return;
    }

    case "new": {
      const name = args[0];
      if (!name) { await bot.reply(msg, "用法: /p new <名称>"); return; }
      if (projectStore.get(wxAcct, name)) {
        await bot.reply(msg, `❌ 项目 "${name}" 已存在。`);
        return;
      }
      const dir = path.join(projRoot, name);
      ensureDir(dir);
      projectStore.save({ wxAccountId: wxAcct, id: name, name, path: dir, gitUrl: null, isTemp: false, createdAt: new Date().toISOString() });
      sessionStore.setCurrentProject(from, name);
      await bot.reply(msg, `✅ 项目 "${name}" 已创建并切换为当前项目。\n   路径: ${dir}`);
      return;
    }

    case "clone": {
      const url = args[0];
      const name = args[1] || url?.replace(/\.git$/, "").split("/").pop();
      if (!url || !name) { await bot.reply(msg, "用法: /p clone <git-url> [名称]"); return; }
      if (projectStore.get(wxAcct, name)) {
        await bot.reply(msg, `❌ 项目 "${name}" 已存在。`);
        return;
      }

      // clone 是长操作：提示 + typing + 不阻塞其他用户（用 userLock 已保证）
      await bot.reply(msg, `⏳ 正在 clone ${url} → ${name}...\n   （大仓库可能需要几分钟）`);

      const dir = path.join(projRoot, name);
      try {
        await gitClone(url, dir, CFG.cloneTimeoutMs);
      } catch (err) {
        const msg2 = err.killed ? `超时（>${Math.round(CFG.cloneTimeoutMs / 1000)}s）` : String(err.stderr || err.message || err).slice(0, 300);
        await bot.reply(msg, `❌ clone 失败: ${msg2}`);
        return;
      }
      projectStore.save({ wxAccountId: wxAcct, id: name, name, path: dir, gitUrl: url, isTemp: false, createdAt: new Date().toISOString() });
      sessionStore.setCurrentProject(from, name);
      await bot.reply(msg, `✅ clone 成功，已切换到项目 "${name}"。\n   路径: ${dir}`);
      return;
    }

    case "rm":
    case "del": {
      const name = args[0];
      if (!name) { await bot.reply(msg, "用法: /p rm <名称>"); return; }
      const proj = projectStore.get(wxAcct, name);
      if (!proj) { await bot.reply(msg, `❌ 项目 "${name}" 不存在。`); return; }

      // 删除目录
      try { fs.rmSync(proj.path, { recursive: true, force: true }); } catch (e) { log.warn(`删除项目目录失败`, { path: proj.path, err: String(e) }); }
      projectStore.remove(wxAcct, name);
      sessionStore.clearSession(from, name);
      await bot.reply(msg, `🗑️ 项目 "${name}" 已删除（代码 + 会话）。`);
      return;
    }

    default: {
      // 子命令不是已知指令 → 当作项目名切换
      const name = subcmd;
      const proj = projectStore.get(wxAcct, name);
      if (!proj) {
        await bot.reply(msg, `❌ 项目 "${name}" 不存在。\n\n${PROJECT_COMMANDS}`);
        return;
      }
      sessionStore.setCurrentProject(from, name);
      const sid = sessionStore.getSession(from, name);
      await bot.reply(msg,
        `📂 已切换到项目 "${proj.name}"\n` +
        `   路径: ${proj.path}\n` +
        `   会话: ${sid ? "已恢复" : "(新会话)"}`);
      return;
    }
  }
}

/**
 * 执行 git clone（带超时）。
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
function gitClone(url, targetDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(`git clone --depth 1 "${url}" "${targetDir}"`, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject({ ...err, stderr: stderr?.toString() || "", stdout: stdout?.toString() || "", message: err.message, killed: err.killed || err.signal === "SIGTERM" });
      else resolve({ stdout: stdout?.toString() || "", stderr: stderr?.toString() || "" });
    });
  });
}

// ---------------------------------------------------------------------------
// 回复格式化 + 分条发送（不变）
// ---------------------------------------------------------------------------

const WX_CHUNK_SIZE = 3000;

function splitIntoChunks(text, maxSize = WX_CHUNK_SIZE) {
  if (!text || text.length <= maxSize) return [text || ""];
  const chunks = [];
  let buf = "";
  const pushLine = (line) => {
    if (line.length > maxSize) {
      for (let i = 0; i < line.length; i += maxSize) chunks.push(line.slice(i, i + maxSize));
      buf = "";
      return;
    }
    if ((buf + (buf ? "\n" : "") + line).length > maxSize) {
      if (buf) chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  };
  for (const para of text.split(/\n\n+/)) {
    if ((buf ? buf + "\n\n" : "").length + para.length > maxSize) {
      if (buf) { chunks.push(buf); buf = ""; }
      for (const ln of para.split("\n")) pushLine(ln);
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text.slice(0, maxSize)];
}

function buildReplyParts(r) {
  if (r.subtype === "timeout" && r.text?.trim()) {
    const note = `\n\n⚠️ _以上为 meta-agent 超时前已生成的部分内容，任务未完成。_`;
    return splitIntoChunks(r.text.trim() + note);
  }
  if (r.ok && r.text?.trim()) return splitIntoChunks(r.text.trim());
  if (r.subtype === "spawn_failed") return [`❌ 无法启动 meta-agent：${r.errors?.[0] ?? "未知错误"}`];
  if (r.subtype === "timeout") return [`⏱️ meta-agent 处理超时，任务已中止。`];
  if (r.subtype === "agent_crashed") {
    const hint = r.stderr?.split("\n").find((l) => /api key|api_key|API key/i.test(l));
    return [`❌ meta-agent 异常退出${hint ? `（${hint.trim()}）` : ""}\nstderr:\n${(r.stderr || r.errors?.[0] || "").slice(0, 500)}`];
  }
  return [`⚠️ 任务未成功完成（${r.subtype}）${r.errors?.length ? "\n" + r.errors.join("\n") : ""}`];
}

async function sendReply(bot, msg, r) {
  const parts = buildReplyParts(r);
  if (parts.length === 1) {
    await bot.reply(msg, parts[0]);
    return parts[0].length;
  }
  const total = parts.length;
  let lastLen = 0;
  for (let i = 0; i < total; i++) {
    await bot.reply(msg, `(${i + 1}/${total}) ` + parts[i]);
    lastLen = parts[i].length;
    if (i < total - 1) await new Promise((t) => setTimeout(t, 300));
  }
  return lastLen;
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

const userLocks = new Map();
let activeTaskCount = 0; // 当前正在执行的 meta-agent 任务数（全局并发信号量）

async function handleMessage(bot, msg) {
  const trig = parseTrigger(msg);
  if (trig.action === "ignore") return;

  const from = msg.fromUserId;
  const wxAcct = msg.accountId;

  // /clear：清当前项目的 session
  if (trig.action === "clear") {
    const curId = sessionStore.getCurrentProject(from);
    if (curId) {
      sessionStore.clearSession(from, curId);
      log.info(`🧹 清除 session`, { from, project: curId });
      await bot.reply(msg, `🧹 项目 "${curId}" 的历史上下文已清除。`).catch(() => {});
    } else {
      await bot.reply(msg, "🧹 当前无活跃项目，无需清除。").catch(() => {});
    }
    return;
  }

  // /p 项目指令
  if (trig.action === "project") {
    await handleProjectCommand(bot, msg, trig.subcmd, trig.args).catch((e) => {
      log.error("handleProjectCommand", { err: String(e) });
      bot.reply(msg, `❌ 项目操作失败: ${e.message}`).catch(() => {});
    });
    return;
  }

  // ── respond / goal：调用 meta-agent ──

  // /goal 无参数：提示用法
  if (trig.action === "goal" && !trig.prompt) {
    await bot.reply(msg, "用法: /goal <目标描述>\n例: /goal 把这个项目重构为 TypeScript").catch(() => {});
    return;
  }

  // 模式选择：/goal 用完整 auto 自主，普通对话用默认（simple_auto）
  const agentMode = trig.action === "goal" ? "auto" : CFG.mode;

  // 全局并发限制：最多同时处理 maxConcurrent 个任务
  if (activeTaskCount >= CFG.maxConcurrent) {
    await bot.reply(msg, `⏳ 系统繁忙，当前已有 ${activeTaskCount} 个任务在处理，请稍后再试。`).catch(() => {});
    return;
  }

  // 同用户串行
  if (userLocks.get(from)) {
    await bot.reply(msg, "⏳ 你上一个任务还在处理，请稍候再发。").catch(() => {});
    return;
  }
  userLocks.set(from, true);
  activeTaskCount++;

  const typing = await bot.typing({ to: from, contextToken: msg.contextToken }).catch(() => null);
  await typing?.start().catch(() => {});

  try {
    // 确定当前项目 + workspace + session
    let curId = sessionStore.getCurrentProject(from);
    let proj = curId ? projectStore.get(wxAcct, curId) : null;

    // 方案 C：无当前项目时自动创建临时项目
    if (!proj) {
      const tempName = `temp-${Date.now().toString(36)}`;
      const dir = path.join(projectStore.projectsRootFor(wxAcct), tempName);
      ensureDir(dir);
      proj = projectStore.save({ wxAccountId: wxAcct, id: tempName, name: tempName, path: dir, gitUrl: null, isTemp: true, createdAt: new Date().toISOString() });
      sessionStore.setCurrentProject(from, tempName);
      curId = tempName;
      log.info(`自动创建临时项目`, { from, project: tempName, path: dir });
    }

    const workspace = proj.path;
    const resumeId = sessionStore.getSession(from, curId);

    const scope = msg.groupId ? `群 ${msg.groupId}` : "私聊";
    log.info(`📩 指令 [${scope}]`, { from, project: curId, prompt: trig.prompt.slice(0, 80), resume: resumeId ?? null });

    const r = await runMetaAgent(trig.prompt, {
      workspace,
      mode: agentMode,
      maxTurns: CFG.maxTurns,
      timeoutMs: CFG.timeoutMs,
      resumeSessionId: resumeId,
      sessionDir: resolveSessionDir(wxAcct),
    });

    if (r.sessionId) sessionStore.setSession(from, curId, r.sessionId);

    // resume 失败：清掉，提示重发
    if (resumeId && !r.ok && r.subtype === "agent_crashed") {
      sessionStore.clearSession(from, curId);
      await bot.reply(msg, "⚠️ 会话已过期或损坏，已自动清除。请重新发送指令。").catch(() => {});
      return;
    }

    const replyLen = await sendReply(bot, msg, r);
    log.info(`✅ 已回复`, { ok: r.ok, subtype: r.subtype, turns: r.numTurns, costUsd: r.costUsd, len: replyLen, project: curId, session: r.sessionId });
  } catch (err) {
    log.error(`meta-agent 执行异常`, { err: String(err) });
    await bot.reply(msg, `❌ 执行异常：${err.message}`).catch(() => {});
  } finally {
    activeTaskCount--;
    userLocks.set(from, false);
    await typing?.stop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

async function cmdCheck() {
  console.log("🔍 自检 meta-agent CLI...\n");
  const r = await checkMetaAgent();
  if (!r.ok) {
    console.error(`❌ meta-agent 不可用：${r.reason ?? `exit ${r.code}`}`);
    console.error("   请安装: npm install -g @meta-agent/runtime");
    process.exit(1);
  }
  console.log(`✅ ${r.version}`);
  console.log(`   mode      : ${CFG.mode}`);
  console.log(`   maxTurns  : ${CFG.maxTurns}`);
  console.log(`   timeout   : ${CFG.timeoutMs > 0 ? CFG.timeoutMs + " ms" : "不限"}`);
  console.log(`   clone超时 : ${CFG.cloneTimeoutMs} ms`);
  console.log(`   最大并发  : ${CFG.maxConcurrent}`);
  console.log(`   群聊策略  : ${CFG.groupTrigger}${CFG.groupTrigger === "prefix" ? ` (前缀 "${CFG.triggerPrefix}")` : ""}`);
  console.log(`   白名单    : ${CFG.allowFrom.length ? CFG.allowFrom.join(", ") : "(不限)"}`);
}

async function cmdAccounts() {
  const bot = new WeixinBot();
  const ids = bot.listAccounts();
  if (!ids.length) {
    console.log("暂无已登录账号。运行: node weixin-meta-agent.mjs --login");
    return;
  }
  console.log("已登录账号：");
  for (const id of ids) {
    const info = bot.getAccountInfo(id);
    console.log(`  ${id}  (userId=${info.userId ?? "?"}, paused=${info.paused})`);
  }
}

async function cmdLogin() {
  const bot = new WeixinBot();
  await bot.login();
  console.log("\n📦 凭据已持久化。运行 `node weixin-meta-agent.mjs` 开始监听。");
}

async function cmdRun() {
  const mc = await checkMetaAgent();
  if (!mc.ok) {
    console.error(`❌ meta-agent 不可用：${mc.reason ?? `exit ${mc.code}`}`);
    console.error("   请安装: npm install -g @meta-agent/runtime");
    process.exit(1);
  }

  const bot = new WeixinBot();
  const existing = bot.listAccounts();
  if (!existing.length) {
    console.error("❌ 没有已登录微信账号。先运行: node weixin-meta-agent.mjs --login");
    process.exit(1);
  }
  bot.setDefaultAccount(existing[0]);
  const info = bot.getAccountInfo();
  if (info.paused) {
    console.error(`❌ 账号 ${info.accountId} 处于 session 暂停期，请稍后或 --login 重登`);
    process.exit(1);
  }

  bot.on("message", (msg) => { handleMessage(bot, msg).catch((e) => log.error("handleMessage", { err: String(e) })); });
  bot.on("error", (err) => log.error(`轮询错误`, { err: String(err) }));
  bot.on("session-expired", (accountId) => {
    console.error(`\n⏸️  Session 过期（账号 ${accountId}）。`);
    console.error(`    已进入熔断保护，暂停约 60 分钟后自动重试轮询（期间不会高频请求服务器）。`);
    console.error(`    如需立即恢复，请在另一终端运行: node weixin-meta-agent.mjs --login\n`);
  });

  console.log("🤖 微信 ↔ meta-agent 桥接已启动");
  console.log(`   meta-agent : ${mc.version}`);
  console.log(`   项目根目录 : ${PROJECTS_DIR}`);
  console.log(`   会话持久化 : 每项目独立 session（微信发 /clear 清当前项目会话）`);
  console.log(`   默认模式   : ${CFG.mode}（/goal <目标> 切换为 auto 完整自主）`);
  console.log(`   私聊       : 全响应（无项目时自动创建临时项目）`);
  console.log(`   群聊       : ${CFG.groupTrigger === "off" ? "不响应" : CFG.groupTrigger === "all" ? "全响应" : `需前缀 "${CFG.triggerPrefix}"`}`);
  console.log(`   项目指令   : /p（私聊群聊均识别）`);
  console.log(`   最大并发   : ${CFG.maxConcurrent}（超过回复"系统繁忙"）`);
  console.log(`   白名单     : ${CFG.allowFrom.length ? CFG.allowFrom.join(", ") : "(不限)"}`);
  console.log("   Ctrl+C 退出\n");
  await bot.start();
}

function printHelp() {
  console.log(`微信 ↔ meta-agent 桥接

用法:
  node weixin-meta-agent.mjs                加载账号并开始监听（默认）
  node weixin-meta-agent.mjs --login        扫码登录
  node weixin-meta-agent.mjs --check        自检 meta-agent CLI + 打印配置
  node weixin-meta-agent.mjs --accounts     列出已登录账号
  node weixin-meta-agent.mjs --help         显示本帮助

微信指令:
  直接发文本           在当前项目 workspace 下触发 meta-agent（每项目独立会话）
  /clear              清除当前项目的历史上下文
  /p                  查看当前项目
  /p list             列出所有项目
  /p new <名称>       创建空项目并切换
  /p clone <url> [名] clone git 项目并切换
  /p <名称>           切换到指定项目
  /p rm <名称>        删除项目（代码 + 会话）
  无项目时发文本       自动创建临时项目
  /goal <目标>        用 auto 完整自主模式执行复杂目标（默认对话为 simple_auto）

环境变量见脚本头部注释。
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) return printHelp();
  if (args.includes("--accounts")) return cmdAccounts();
  if (args.includes("--login")) return cmdLogin();
  if (args.includes("--check")) return cmdCheck();
  return cmdRun();
}

installProcessGuards();

main().catch((err) => {
  console.error("Fatal:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
