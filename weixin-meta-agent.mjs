#!/usr/bin/env node
/** Four explicit entry points, backed by durable inbox/execution/outbox state. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WeixinBot, log } from './src/index.mjs';
import { resolveStateDir } from './src/util.mjs';
import { RuntimeAdapter } from './src/runtime-adapter.mjs';
import { PersonalAgent } from './src/personal-agent.mjs';
import { createTasksAgenticConsole, TASKS_HELP } from './src/tasks-agentic.mjs';
import { createHumanTasks, loadHumanDefaultRecipient, loadHumanRoutes } from './src/human-tasks.mjs';
import { COMMAND_HELP } from './src/message-trigger.mjs';
import { installGracefulShutdown } from './src/process-guard.mjs';

function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
export function loadConfig(env = process.env) {
  return { allowFrom: (env.WEIXIN_ALLOW_FROM || '').split(',').map(s => s.trim()).filter(Boolean),
    groupTrigger: env.WEIXIN_GROUP_TRIGGER || 'off', maxConcurrent: Math.floor(positive(env.META_AGENT_MAX_CONCURRENT, 2)),
    maxTurns: Math.floor(positive(env.META_AGENT_MAX_TURNS, 30)), maxBudgetUsd: positive(env.META_AGENT_MAX_BUDGET_USD, 10),
    timeoutMs: Math.max(0, Number(env.META_AGENT_TIMEOUT_MS) || 0) };
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
    console.log(`微信个人智能体\n${COMMAND_HELP}\n\n${TASKS_HELP}\n\n本机命令：--login、--accounts、--check、--tasks-check、--human-check`); return;
  }
  if (args.includes('--check')) {
    console.log(JSON.stringify({ execution: await adapter.check('auto'), talk: await adapter.check('talk'), tasks: await adapter.check('tasks'), cfg }, null, 2)); return;
  }
  if (args.includes('--tasks-check')) {
    const console_ = createTasksAgenticConsole();
    try { const result = await console_.check(); console.log(result); if (result.startsWith('❌')) process.exitCode = 1; }
    finally { await console_.close(); } return;
  }
  let app;
  const bot = new WeixinBot({ inboundHandler: msg => app.accept(msg) });
  if (args.includes('--accounts')) { for (const id of bot.listAccounts()) console.log(bot.getAccountInfo(id)); return; }
  if (args.includes('--login')) { const result = await bot.login(); if (result.connected === false) { console.error(result.message); process.exitCode = 1; } return; }
  if (args.includes('--human-check')) { console.log(await makeHuman(bot, adapter, stateDir, cfg).check()); return; }
  const ready = await adapter.check('auto');
  if (!ready.ok) throw new Error(`meta-agent 不可用：${ready.reason || ready.code}`);
  await adapter.check('talk'); await adapter.check('tasks');
  if (!bot.listAccounts().length) throw new Error('请先运行 npm run agent:login 扫码登录');
  app = new PersonalAgent({ root: path.join(stateDir, 'personal-agent'), bot, cfg, adapter, log });
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
