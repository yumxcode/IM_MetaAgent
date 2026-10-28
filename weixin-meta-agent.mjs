#!/usr/bin/env node
/** Four explicit entry points, backed by durable inbox/execution/outbox state. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WeixinBot, log } from './src/index.mjs';
import { resolveStateDir } from './src/util.mjs';
import { RuntimeAdapter } from './src/runtime-adapter.mjs';
import { PersonalAgent } from './src/personal-agent.mjs';
import { createTasksAgenticConsole, TASKS_HELP } from './src/tasks-agentic.mjs';
import { createHumanTasks, loadHumanDefaultRecipient, loadHumanRoutes } from './src/human-tasks.mjs';
import { COMMAND_HELP } from './src/message-trigger.mjs';
import { installGracefulShutdown } from './src/process-guard.mjs';
import { AlertNotifier, ConnectionMonitor } from './src/alerts.mjs';
import { readState } from './src/durable-store.mjs';

function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
/** Non-negative number where an explicit 0 disables the feature. */
function nonNegative(value, fallback) { if (value === undefined || value === '') return fallback; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
export function loadConfig(env = process.env) {
  return { allowFrom: (env.WEIXIN_ALLOW_FROM || '').split(',').map(s => s.trim()).filter(Boolean),
    groupTrigger: env.WEIXIN_GROUP_TRIGGER || 'off', maxConcurrent: Math.floor(positive(env.META_AGENT_MAX_CONCURRENT, 2)),
    maxTurns: Math.floor(positive(env.META_AGENT_MAX_TURNS, 30)), maxBudgetUsd: positive(env.META_AGENT_MAX_BUDGET_USD, 10),
    timeoutMs: Math.max(0, Number(env.META_AGENT_TIMEOUT_MS) || 0),
    retentionDays: nonNegative(env.IM_RETENTION_DAYS, 30),
    decisionPollMs: nonNegative(env.META_AGENT_DECISION_POLL_MS, 120000),
    sendFiles: env.IM_SEND_FILES !== 'false', sendFilesMax: Math.floor(positive(env.IM_SEND_FILES_MAX, 5)),
    sendFileMaxBytes: Math.floor(positive(env.IM_SEND_FILE_MAX_MB, 25) * 1024 * 1024) };
}
export function setupLogFile(env = process.env, projectDir = path.dirname(fileURLToPath(import.meta.url))) {
  const file = env.IM_LOG_FILE?.trim();
  if (!file || file === 'stderr') return null;
  return log.useFile(path.resolve(projectDir, file), { maxBytes: positive(env.IM_LOG_MAX_MB, 10) * 1024 * 1024, keep: Math.floor(positive(env.IM_LOG_FILES, 5)) });
}
function ownerCommand(args, stateDir, cfg) {
  const root = path.join(stateDir, 'personal-agent');
  if (args.includes('--owner')) {
    const state = readState(path.join(root, 'state.json'), {});
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
    console.log(JSON.stringify({ execution: await adapter.check('auto'), talk: await adapter.check('talk'), tasks: await adapter.check('tasks'), cfg }, null, 2)); return;
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
  await adapter.check('talk'); await adapter.check('tasks');
  if (!bot.listAccounts().length) throw new Error('请先运行 npm run agent:login 扫码登录');
  app = new PersonalAgent({ root: path.join(stateDir, 'personal-agent'), bot, cfg, adapter, log, alerts });
  new ConnectionMonitor({ alerts, offlineAfterMs: positive(process.env.IM_ALERT_OFFLINE_MINUTES, 10) * 60 * 1000 }).attach(bot);
  log.info(`告警通道：${alerts.describe()}`);
  if (!cfg.allowFrom.length) log.info(app.store.state.owner ? `仅主人可用：${app.store.state.owner.userId}` : '未设置 WEIXIN_ALLOW_FROM：首位私聊者将被绑定为主人');
  let human;
  try {
    if (process.env.META_AGENT_HUMAN_ENABLED === 'true') {
      human = makeHuman(app.humanBot(), adapter, stateDir, cfg); app.setHumanTasks(human); human.start();
    }
    bot.on('error', error => log.error('微信接入错误', { message: error.message }));
    bot.on('session-expired', () => log.warn('微信凭据已过期，待发送结果已保留；请重新登录。'));
    const removeShutdown = installGracefulShutdown(bot, { close: async () => { await human?.close(); await app.close(); } });
    console.log(`微信个人智能体已启动\n${COMMAND_HELP}\n新工作默认 auto；进入 /auto 模式后，首条发送 --sapiens 目标 可启用人工工单。`);
    app.start();
    try { await bot.start(); }
    finally { removeShutdown(); }
  } finally { await human?.close(); await app.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
