#!/usr/bin/env node
/**
 * Reminder helper for /talk (copied into the chat workspace as .im/remind.mjs).
 *
 * The chat agent is a meta-agent CLI session, so IM cannot inject tools into it.
 * Instead the agent runs this script from its own workspace; requests are only
 * validated and appended to .im/requests.jsonl. The IM bot applies them (and
 * validates again) when the turn finishes, and confirms them to the user.
 *
 *   node .im/remind.mjs list
 *   node .im/remind.mjs create --text "喝水" --at "2026-10-29 08:00"
 *   node .im/remind.mjs create --text "搜索今日新闻并总结" --cron "0 8 * * 1-5" --kind talk
 *   node .im/remind.mjs cancel R3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSchedule, describeSchedule, MAX_ACTIVE_SCHEDULES } from './schedules.mjs';

export function runRemindCli(argv, { dir, now = Date.now() } = {}) {
  const read = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8')); } catch { return []; } };
  const requests = path.join(dir, 'requests.jsonl');
  const pending = () => { try { return fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const append = op => fs.appendFileSync(requests, `${JSON.stringify(op)}\n`, { mode: 0o600 });
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--(text|at|cron|kind)$/.exec(rest[i]);
    if (m) { flags[m[1]] = rest[++i]; continue; }
    flags._ = [...(flags._ || []), rest[i]];
  }
  if (command === 'list') {
    const current = read(), queued = pending();
    const lines = current.map(s => describeSchedule(s, now));
    for (const op of queued) lines.push(op.type === 'create' ? `（本轮待确认）${describeSchedule(op, now)}` : `（本轮待取消）${op.id}`);
    return { code: 0, out: lines.join('\n') || '当前没有有效的提醒或定时任务。' };
  }
  if (command === 'create') {
    if (read().length + pending().filter(op => op.type === 'create').length >= MAX_ACTIVE_SCHEDULES) return { code: 1, out: `未创建：最多 ${MAX_ACTIVE_SCHEDULES} 个有效提醒` };
    const plan = planSchedule({ text: flags.text ?? flags._?.join(' '), at: flags.at, cron: flags.cron, kind: flags.kind || 'remind' }, now);
    append({ type: 'create', ...plan });
    return { code: 0, out: `已提交：${describeSchedule(plan, now)}。机器人会在本条回复后发确认和编号。` };
  }
  if (command === 'cancel') {
    const id = String(flags._?.[0] || '').toUpperCase();
    if (!read().some(s => s.id === id)) return { code: 1, out: `没有有效的提醒 ${id || '(未提供编号)'}` };
    append({ type: 'cancel', id });
    return { code: 0, out: `已提交取消 ${id}。` };
  }
  return { code: 2, out: '用法：list | create --text <内容> (--at "YYYY-MM-DD HH:mm" | --cron "分 时 日 月 周") [--kind remind|talk] | cancel R1' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runRemindCli(process.argv.slice(2), { dir: path.dirname(fileURLToPath(import.meta.url)) });
    console.log(result.out); process.exitCode = result.code;
  } catch (error) { console.log(`未创建：${error.message}`); process.exitCode = 1; }
}
