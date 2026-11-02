#!/usr/bin/env node
/** WeChat personal assistant: one resident chat assistant, auto work tasks, durable inbox/execution/outbox state. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WeixinBot, log } from './src/index.mjs';
import { resolveStateDir } from './src/util.mjs';
import { RuntimeAdapter, ASSISTANT_SYSTEM_PROMPT } from './src/runtime-adapter.mjs';
import { resolveRuntimeCli } from './src/runtime-cli.mjs';
import { TalkHost, probeServe } from './src/talk-host.mjs';
import { parseRoots, displayPath } from './src/workspaces.mjs';
import { PersonalAgent } from './src/personal-agent.mjs';
import { createTasksAgenticConsole, TASKS_HELP } from './src/tasks-agentic.mjs';
import { createHumanTasks, loadHumanDefaultRecipient, loadHumanRoutes } from './src/human-tasks.mjs';
import { COMMAND_HELP } from './src/message-trigger.mjs';
import { installGracefulShutdown } from './src/process-guard.mjs';
import { AlertNotifier, ConnectionMonitor } from './src/alerts.mjs';
import { loadState } from './src/durable-store.mjs';

function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
/** Positive number, or undefined when unset/invalid (the runtime default then applies). */
function optionalPositive(value, integer = false) {
  if (value === undefined || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (integer ? Math.floor(n) : n) : undefined;
}
/** "meta-agent v0.13.3" → compares against [major, minor, patch]. */
export function runtimeAtLeast(versionText, wanted) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionText || ''));
  if (!m) return false;
  const have = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== wanted[i]) return have[i] > wanted[i];
  return true;
}
/** Settings from 1.2 that capped every Auto run (30 turns / $10); now ignored. */
export function deprecatedLimitKeys(env = process.env) {
  return ['META_AGENT_MAX_TURNS', 'META_AGENT_MAX_BUDGET_USD'].filter(key => env[key] !== undefined && env[key] !== '');
}
/** What every route runs, for --check and the startup log. */
export function describeRuntimeCli(env = process.env) {
  const { cli, bin, profile, runtimeDir, source, problems } = resolveRuntimeCli(env);
  return { cli, bin, profile, ...(runtimeDir ? { runtimeDir } : {}), source, usedBy: 'auto、聊天助手、tasks 运维、人工工单', ...(problems.length ? { problems } : {}) };
}
/** Non-negative number where an explicit 0 disables the feature. */
function nonNegative(value, fallback) { if (value === undefined || value === '') return fallback; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
export function loadConfig(env = process.env) {
  return { allowFrom: (env.WEIXIN_ALLOW_FROM || '').split(',').map(s => s.trim()).filter(Boolean),
    groupTrigger: env.WEIXIN_GROUP_TRIGGER || 'off', maxConcurrent: Math.floor(positive(env.META_AGENT_MAX_CONCURRENT, 2)),
    // Unset limits = meta-agent defaults. These are forwarded as --max-turns / --max-budget-usd only when set.
    autoMaxTurns: optionalPositive(env.META_AGENT_AUTO_MAX_TURNS, true), autoMaxBudgetUsd: optionalPositive(env.META_AGENT_AUTO_MAX_BUDGET_USD),
    talkMaxTurns: optionalPositive(env.META_AGENT_TALK_MAX_TURNS, true), talkMaxBudgetUsd: optionalPositive(env.META_AGENT_TALK_MAX_BUDGET_USD),
    timeoutMs: Math.max(0, Number(env.META_AGENT_TIMEOUT_MS) || 0),
    talkTimeoutMs: nonNegative(env.META_AGENT_TALK_TIMEOUT_MS, 15 * 60 * 1000),
    retentionDays: nonNegative(env.IM_RETENTION_DAYS, 7),
    // Isolated task folders hold deliverables; removing them after retention is opt-in.
    pruneTaskWorkspaces: env.IM_PRUNE_TASK_WORKSPACES === 'true',
    decisionPollMs: nonNegative(env.META_AGENT_DECISION_POLL_MS, 120000),
    sendFiles: env.IM_SEND_FILES !== 'false', sendFilesMax: Math.floor(positive(env.IM_SEND_FILES_MAX, 5)),
    sendFileMaxBytes: Math.floor(positive(env.IM_SEND_FILE_MAX_MB, 25) * 1024 * 1024),
    talkServe: env.IM_TALK_SERVE !== 'false', talkMaxConcurrent: Math.floor(positive(env.META_AGENT_TALK_MAX_CONCURRENT, 2)),
    slowNoticeMs: nonNegative(env.IM_SLOW_NOTICE_MS, 20000), typing: env.IM_TYPING !== 'false',
    ...(() => { const { roots, problems } = parseRoots(env.IM_WORKSPACE_ROOTS); return { workspaceRoots: roots, workspaceRootProblems: problems }; })(),
    workspaceScanDepth: Math.min(4, Math.floor(positive(env.IM_WORKSPACE_SCAN_DEPTH, 2))) };
}
/** `meta-agent serve` arguments and environment for the resident assistant. */
export function serveLaunch(cfg, adapter, root) {
  const settings = adapter.settings('talk');
  const hostTools = path.join(root, 'serve', 'host-tools.json');
  const args = ['--mode', 'simple_auto', '--yes', '--session-dir', path.join(root, 'runtime-sessions'), '--host-tools', hostTools, '--system', ASSISTANT_SYSTEM_PROMPT,
    ...(cfg.talkMaxTurns ? ['--max-turns', String(cfg.talkMaxTurns)] : []), ...(cfg.talkMaxBudgetUsd ? ['--max-budget-usd', String(cfg.talkMaxBudgetUsd)] : [])];
  const env = { ...adapter.env, ...(settings.profile ? { META_AGENT_CONFIG_FILE: settings.profile } : {}), ...(settings.runtimeDir ? { META_AGENT_RUNTIME_DIR: settings.runtimeDir } : {}) };
  return { bin: settings.bin, args, env, hostTools };
}
export function setupLogFile(env = process.env, projectDir = path.dirname(fileURLToPath(import.meta.url))) {
  const file = env.IM_LOG_FILE?.trim();
  if (!file || file === 'stderr') return null;
  return log.useFile(path.resolve(projectDir, file), { maxBytes: positive(env.IM_LOG_MAX_MB, 10) * 1024 * 1024, keep: Math.floor(positive(env.IM_LOG_FILES, 5)) });
}
function ownerCommand(args, stateDir, cfg) {
  const root = path.join(stateDir, 'personal-agent');
  if (args.includes('--owner')) {
    const state = loadState(root);
    const contacts = [...new Set(Object.entries(state.contacts || {}).filter(([key]) => { try { return JSON.parse(key)[2] === 'private'; } catch { return false; } }).map(([, c]) => c.userId))];
    console.log(JSON.stringify({ allowFrom: cfg.allowFrom, owner: state.owner || null, ownerAmbiguous: Boolean(state.ownerAmbiguous), privateContacts: contacts }, null, 2));
    return true;
  }
  const bindIndex = args.indexOf('--bind-owner');
  if (bindIndex < 0 && !args.includes('--reset-owner') && !args.includes('--prune')) return false;
  const app = new PersonalAgent({ root, bot: null, cfg, adapter: new RuntimeAdapter(), log });
  try {
    if (bindIndex >= 0) {
      const userId = args[bindIndex + 1];
      if (!userId || userId.startsWith('--')) throw new Error('用法：--bind-owner <微信用户ID>');
      app.bindOwner(userId, 'cli'); console.log(`已绑定主人：${userId}`);
    } else if (args.includes('--reset-owner')) {
      app.store.update(state => { delete state.owner; delete state.ownerAmbiguous; });
      console.log('已解除主人绑定；下一位私聊者将成为主人。');
    } else console.log(JSON.stringify(app.prune({ dryRun: args.includes('--dry-run') }), null, 2));
  } finally { app.store.close(); }
  return true;
}
function stateDirectory() {
  const base = resolveStateDir();
  return path.join(base, fs.existsSync(path.join(base, 'weixin-bot')) ? 'weixin-bot' : 'openclaw-weixin');
}
function makeHuman(bot, adapter, stateDir, cfg) {
  return createHumanTasks({ bot, api: adapter.humanApi(), stateDir: path.join(stateDir, 'human'),
    routes: loadHumanRoutes(process.env.META_AGENT_HUMAN_ROUTES), allowFrom: cfg.allowFrom,
    defaultRecipient: loadHumanDefaultRecipient(process.env, bot.getDefaultAccount()),
    pollMs: positive(process.env.META_AGENT_HUMAN_POLL_MS, 5000), log });
}
export async function main(args = process.argv.slice(2)) {
  const cfg = loadConfig(), stateDir = stateDirectory(), adapter = new RuntimeAdapter();
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`微信个人智能体\n${COMMAND_HELP}\n\n${TASKS_HELP}\n\n本机命令：--login、--accounts、--check、--tasks-check、--human-check、--alert-test、--owner、--bind-owner <ID>、--reset-owner、--prune [--dry-run]`); return;
  }
  if (ownerCommand(args, stateDir, cfg)) return;
  const alerts = new AlertNotifier({ stateFile: path.join(stateDir, 'personal-agent-alerts.json') });
  if (args.includes('--alert-test')) {
    console.log(`告警通道：${alerts.describe()}`);
    if (alerts.send('这是一条测试告警：IM MetaAgent 告警通道工作正常。')) await alerts.flush();
    alerts.close(); return;
  }
  if (!args.length || args.every(a => a === '--listen')) {
    setupLogFile();
    try { return await runService({ cfg, stateDir, adapter, alerts }); }
    catch (error) {
      if (alerts.send(`机器人启动失败：${error.message}`, { key: `startup:${error.message.slice(0, 80)}` })) await Promise.race([alerts.flush(), new Promise(r => setTimeout(r, 15000))]);
      throw error;
    } finally { alerts.close(); }
  }
  if (args.includes('--check')) {
    const talk = await adapter.check('talk'), settings = adapter.settings('talk');
    const serve = await probeServe(settings.bin, { env: serveLaunch(cfg, adapter, stateDir).env });
    console.log(JSON.stringify({ runtimeCli: describeRuntimeCli(), execution: await adapter.check('auto'), talk: { ...talk, residentAssistant: serve ? '支持（meta-agent serve）' : '不支持，使用单次运行' }, tasks: await adapter.check('tasks'), cfg }, null, 2)); return;
  }
  if (args.includes('--tasks-check')) {
    const console_ = createTasksAgenticConsole();
    try { const result = await console_.check(); console.log(result); if (result.startsWith('❌')) process.exitCode = 1; }
    finally { await console_.close(); } return;
  }
  const bot = new WeixinBot();
  if (args.includes('--accounts') || args.includes('--login') || args.includes('--human-check')) return accountCommand(args, bot, adapter, stateDir, cfg);
  throw new Error(`未知参数：${args.join(' ')}`);
}
async function accountCommand(args, bot, adapter, stateDir, cfg) {
  if (args.includes('--accounts')) { for (const id of bot.listAccounts()) console.log(bot.getAccountInfo(id)); return; }
  if (args.includes('--login')) { const result = await bot.login(); if (result.connected === false) { console.error(result.message); process.exitCode = 1; } return; }
  if (args.includes('--human-check')) { console.log(await makeHuman(bot, adapter, stateDir, cfg).check()); return; }
}
async function runService({ cfg, stateDir, adapter, alerts }) {
  let app;
  const bot = new WeixinBot({ inboundHandler: msg => app.accept(msg) });
  const ready = await adapter.check('auto');
  if (!ready.ok) throw new Error(`meta-agent 不可用：${ready.reason || ready.code}`);
  const talkReady = await adapter.check('talk'); await adapter.check('tasks');
  if (!runtimeAtLeast(talkReady.version, [0, 13, 3])) log.warn(`meta-agent ${talkReady.version || '版本未知'} 低于 0.13.3：/talk 的 MCP 与 skill 不会与其他模式隔离（仍读 mcp.json 与全局 skills），且 simple_auto 无法调用 MCP 工具。请升级 meta-agent 后运行 npm run agent:setup-simple-auto。`);
  if (!bot.listAccounts().length) throw new Error('请先运行 npm run agent:login 扫码登录');
  app = new PersonalAgent({ root: path.join(stateDir, 'personal-agent'), bot, cfg, adapter, log, alerts });
  for (const problem of cfg.workspaceRootProblems || []) log.warn(`IM_WORKSPACE_ROOTS 忽略：${problem}`);
  log.info(cfg.workspaceRoots.length ? `助理可访问的文件夹：${cfg.workspaceRoots.map(r => displayPath(r)).join('、')}` : '未设置 IM_WORKSPACE_ROOTS：工作任务只使用独立目录');
  const talkHost = await startTalkHost(cfg, adapter, app);
  new ConnectionMonitor({ alerts, offlineAfterMs: positive(process.env.IM_ALERT_OFFLINE_MINUTES, 10) * 60 * 1000 }).attach(bot);
  log.info(`告警通道：${alerts.describe()}`);
  const runtimeCli = resolveRuntimeCli();
  log.info(`meta-agent：${runtimeCli.cli}（${runtimeCli.bin}），模型配置 ${runtimeCli.profile}；auto、聊天助手、tasks、人工工单统一使用`);
  for (const problem of runtimeCli.problems) log.warn(problem);
  const deprecated = deprecatedLimitKeys();
  if (deprecated.length) log.warn(`${deprecated.join('、')} 已停用并被忽略：auto 与 talk 默认使用 meta-agent 自身的轮数/预算；如需限制，改用 META_AGENT_AUTO_MAX_TURNS / META_AGENT_AUTO_MAX_BUDGET_USD / META_AGENT_TALK_MAX_TURNS / META_AGENT_TALK_MAX_BUDGET_USD。`);
  if (!cfg.allowFrom.length) log.info(app.store.state.owner ? `仅主人可用：${app.store.state.owner.userId}` : '未设置 WEIXIN_ALLOW_FROM：首位私聊者将被绑定为主人');
  let human;
  try {
    if (process.env.META_AGENT_HUMAN_ENABLED === 'true') {
      human = makeHuman(app.humanBot(), adapter, stateDir, cfg); app.setHumanTasks(human); human.start();
    }
    bot.on('error', error => log.error('微信接入错误', { message: error.message }));
    bot.on('session-expired', () => log.warn('微信凭据已过期，待发送结果已保留；请重新登录。'));
    const removeShutdown = installGracefulShutdown(bot, { close: async () => { await human?.close(); await talkHost?.close(); await app.close(); } });
    console.log(`微信个人智能体已启动（${talkHost ? '常驻助手' : '单次运行助手'}）\n${COMMAND_HELP}`);
    app.start();
    try { await bot.start(); }
    finally { removeShutdown(); }
  } finally { await human?.close(); await talkHost?.close(); await app.close(); }
}
/** Start the resident assistant when the runtime supports `serve`; otherwise chat keeps using one-shot runs. */
async function startTalkHost(cfg, adapter, app) {
  if (!cfg.talkServe) { log.info('IM_TALK_SERVE=false：聊天使用单次运行'); return null; }
  const launch = serveLaunch(cfg, adapter, app.root);
  if (!await probeServe(launch.bin, { env: launch.env })) {
    log.warn('当前 meta-agent 不支持 serve（需要 ≥ 0.14），聊天使用单次运行；升级 runtime 后可获得常驻助手、文件夹浏览和任务确认。');
    return null;
  }
  fs.mkdirSync(path.dirname(launch.hostTools), { recursive: true, mode: 0o700 });
  fs.writeFileSync(launch.hostTools, JSON.stringify(app.tools.specs, null, 1), { mode: 0o600 });
  const host = new TalkHost({ bin: launch.bin, args: launch.args, env: launch.env, log, onToolCall: (name, input, meta) => app.tools.call(name, input, meta) });
  app.setTalkHost(host);
  // Warm up in the background; the first chat turn waits for readiness if needed.
  host.start().catch(error => log.warn(`常驻助手暂未启动：${error.message}`));
  return host;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
