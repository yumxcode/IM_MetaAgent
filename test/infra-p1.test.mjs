import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { AlertNotifier, ConnectionMonitor, resolveAlertChannels, buildAlertPayload } from '../src/alerts.mjs';
import { RotatingLogFile, RepeatSuppressor } from '../src/util.mjs';
import { parseCron, nextCronTime, parseAt, planSchedule, describeCron, createScheduleTools, advanceSchedule } from '../src/schedules.mjs';
import { declaredPathsFromEvent, collectDeliverables, containedFile } from '../src/deliverables.mjs';
import { startPolling } from '../src/poller.mjs';
import { _resetSessionGuardForTest } from '../src/session-guard.mjs';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-infra-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('alert channels come from the runtime notify config, with env expansion and direct override', t => {
  const root = temp(t), file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ notify: { default: 'me', channels: {
    me: { type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/${HOOK}', secret: 'sec' },
    other: { type: 'slack', url: 'https://hooks.slack.com/x' } } } }));
  const fromConfig = resolveAlertChannels({ META_AGENT_CONFIG_FILE: file, META_AGENT_HOME: root, HOOK: 'abc' });
  assert.deepEqual(fromConfig.channels.map(c => [c.name, c.type, c.url]), [['me', 'feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc']]);
  const missing = resolveAlertChannels({ META_AGENT_CONFIG_FILE: file, META_AGENT_HOME: root });
  assert.equal(missing.channels.length, 0); assert.match(missing.issues[0], /HOOK/);
  const named = resolveAlertChannels({ META_AGENT_CONFIG_FILE: file, META_AGENT_HOME: root, IM_ALERT_CHANNEL: 'other' });
  assert.equal(named.channels[0].type, 'slack');
  const direct = resolveAlertChannels({ META_AGENT_HOME: root, IM_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T' });
  assert.equal(direct.channels[0].type, 'slack');
  assert.equal(resolveAlertChannels({ META_AGENT_HOME: root, IM_ALERT_WEBHOOK_URL: 'file:///etc/passwd' }).channels.length, 0);
});

test('feishu payload is signed like the runtime notify tool', () => {
  const body = buildAlertPayload({ type: 'feishu', secret: 's' }, 'hi', 1_700_000_000_000);
  assert.equal(body.timestamp, '1700000000');
  assert.equal(body.sign, createHmac('sha256', '1700000000\ns').update('').digest('base64'));
  assert.deepEqual(buildAlertPayload({ type: 'webhook' }, 'hi'), { text: 'hi' });
});

test('alerts dedupe by key across restarts and retry failed deliveries', async t => {
  const root = temp(t), stateFile = path.join(root, 'alerts.json'), posts = [];
  let fail = true, time = 1000;
  const fetchFn = async (url, init) => { posts.push(JSON.parse(init.body).content.text); if (fail) throw new Error('offline'); return new Response('{"code":0}'); };
  const channels = [{ name: 'me', type: 'feishu', url: 'https://open.feishu.cn/x', headers: {} }];
  const alerts = new AlertNotifier({ stateFile, fetchFn, channels, now: () => time });
  t.after(() => alerts.close());
  assert.equal(alerts.send('登录失效', { key: 'expired:b' }), true);
  await alerts.flush(); assert.equal(alerts.queue.length, 1);
  assert.equal(alerts.send('登录失效', { key: 'expired:b' }), false);
  fail = false; time += 60 * 1000; await alerts.flush();
  assert.equal(alerts.queue.length, 0); assert.equal(posts.length, 2); assert.match(posts[1], /登录失效/);
  const again = new AlertNotifier({ stateFile, fetchFn, channels, now: () => time });
  assert.equal(again.send('登录失效', { key: 'expired:b' }), false);
  again.reset('expired:b'); assert.equal(again.send('登录失效', { key: 'expired:b' }), true);
  await again.flush(); again.close();
});

test('connection monitor alerts on stale login, long outages and recovery', () => {
  const sent = []; let time = 0;
  const monitor = new ConnectionMonitor({ alerts: { send: (text, opts) => { sent.push(text); return true; }, reset() {} }, offlineAfterMs: 10 * 60 * 1000, now: () => time });
  monitor.onError(new Error('DNS')); time += 5 * 60 * 1000; monitor.onError(new Error('DNS'));
  assert.equal(sent.length, 0);
  time += 6 * 60 * 1000; monitor.onError(new Error('DNS')); monitor.onError(new Error('DNS'));
  assert.equal(sent.length, 1); assert.match(sent[0], /连续失败 11 分钟/);
  monitor.onRecovered({ accountId: 'b', downMs: 11 * 60 * 1000 });
  assert.match(sent[1], /已恢复/);
  monitor.onError({ errcode: -14, message: 'session timeout' });
  monitor.onExpired('b');
  assert.match(sent[2], /npm run agent:login/);
  monitor.onRecovered({ accountId: 'b', downMs: 60000 }); monitor.onRecovered({ accountId: 'b', downMs: 0 });
  assert.equal(sent.length, 4, 'recovery is announced only after an alert');
});

test('poller reports recovery once after failures', async () => {
  _resetSessionGuardForTest();
  const controller = new AbortController(), healthy = [];
  let call = 0;
  await startPolling({ baseUrl: 'https://x', token: 't', accountId: 'acc', abortSignal: controller.signal,
    sleepFn: async () => {}, minEmptyPollDelayMs: 0,
    getUpdatesFn: async () => { call++; if (call <= 2) throw new TypeError('fetch failed'); if (call >= 4) controller.abort(); return { ret: 0, msgs: [] }; },
    onHealthy: info => healthy.push(info) });
  assert.equal(healthy.length, 1); assert.equal(healthy[0].accountId, 'acc');
});

test('rotating log keeps a bounded number of files', t => {
  const root = temp(t), file = path.join(root, 'app.log');
  const sink = new RotatingLogFile(file, { maxBytes: 4096, keep: 2 });
  for (let i = 0; i < 40; i++) sink.write(`${'x'.repeat(500)}\n`);
  sink.close();
  assert.deepEqual(fs.readdirSync(root).sort(), ['app.log', 'app.log.1', 'app.log.2']);
  for (const name of fs.readdirSync(root)) assert.ok(fs.statSync(path.join(root, name)).size <= 4096);
});

test('repeated log lines are merged within the window and counted', () => {
  let time = 0;
  const repeat = new RepeatSuppressor({ windowMs: 1000, now: () => time });
  assert.deepEqual(repeat.check('dns'), { suppressedBefore: 0 });
  assert.equal(repeat.check('dns'), null); assert.equal(repeat.check('dns'), null);
  assert.ok(repeat.check('other'));
  time = 1500;
  assert.deepEqual(repeat.check('dns'), { suppressedBefore: 2 });
  assert.equal(repeat.check('dns'), null);
  time = 3000;
  assert.deepEqual(repeat.drain().map(d => [d.key, d.count]), [['dns', 1]]);
});

test('cron and one-shot parsing', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  const now = at(2026, 10, 28, 9, 40);
  assert.equal(nextCronTime('0 8 * * *', now), at(2026, 10, 29, 8, 0));
  assert.equal(nextCronTime('30 9 * * 1-5', at(2026, 10, 30, 10, 0)), at(2026, 11, 2, 9, 30));
  assert.equal(nextCronTime('0 0 1 * *', now), at(2026, 11, 1, 0, 0));
  assert.equal(nextCronTime('0 9 * * 7', now), at(2026, 11, 1, 9, 0));
  assert.equal(nextCronTime('0 9 29 2 *', now), null);
  assert.throws(() => parseCron('0 8 * *'), /5 个字段/);
  assert.throws(() => parseCron('61 8 * * *'), /范围/);
  assert.equal(parseAt('08:00', now), at(2026, 10, 29, 8, 0));
  assert.equal(parseAt('2026-10-28 18:30', now), at(2026, 10, 28, 18, 30));
  assert.throws(() => parseAt('2026-02-30 10:00', now));
  assert.equal(describeCron('0 8 * * 1-5'), '工作日 08:00');
  assert.equal(describeCron('0 15 * * 1,3,5'), '每周一、三、五 15:00');
  assert.throws(() => planSchedule({ text: 'x', cron: '* * * * *' }, now), /频率过高/);
  assert.throws(() => planSchedule({ text: 'x', at: '2026-10-28 09:00' }, now), /已过去/);
  assert.throws(() => planSchedule({ text: 'x', at: '2026-10-29 09:00', cron: '0 8 * * *' }, now), /二选一/);
  assert.equal(advanceSchedule({ at: 1 }, now), null);
});

test('chat schedule tools only propose operations and validate input', async () => {
  const ops = [];
  const [create, list, cancel] = createScheduleTools({ existing: [{ id: 'R1', kind: 'remind', text: '喝水', cron: '0 15 * * *', nextAt: Date.now() + 1000 }], ops });
  assert.equal((await create.call({ text: '开会', at: '00:00' })).isError, false);
  assert.equal((await create.call({ text: '错误', cron: 'bad' })).isError, true);
  assert.match((await list.call({})).content, /R1 · 提醒 · 每天 15:00/);
  assert.equal((await cancel.call({ id: 'r9' })).isError, true);
  assert.equal((await cancel.call({ id: 'r1' })).isError, false);
  assert.deepEqual(ops.map(op => op.type), ['create', 'cancel']);
  assert.equal(ops[1].id, 'R1');
});

test('deliverables stay inside the workspace; undeclared runs fall back to recent documents', t => {
  const root = temp(t), workspace = path.join(root, 'ws'), outside = path.join(root, 'secret.pdf');
  fs.mkdirSync(path.join(workspace, 'out'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'im-inputs'));
  fs.writeFileSync(path.join(workspace, 'out', 'a.pdf'), 'a'); fs.writeFileSync(outside, 's');
  fs.writeFileSync(path.join(workspace, 'im-inputs', 'upload.pdf'), 'u'); fs.writeFileSync(path.join(workspace, 'code.js'), 'c');
  fs.symlinkSync(outside, path.join(workspace, 'link.pdf'));
  assert.equal(containedFile(workspace, '../secret.pdf'), null);
  assert.equal(containedFile(workspace, 'link.pdf'), null);
  assert.equal(containedFile(workspace, outside), null);
  assert.deepEqual(declaredPathsFromEvent({ type: 'tool_use', toolName: 'task_journal', toolInput: { kind: 'artifact', paths: ['out/a.pdf', '../secret.pdf'] } }), ['out/a.pdf', '../secret.pdf']);
  assert.deepEqual(declaredPathsFromEvent({ type: 'tool_use', toolName: 'task_journal', toolInput: { kind: 'progress', text: 'x' } }), []);
  const declared = collectDeliverables({ workspace, declared: ['out/a.pdf', '../secret.pdf', 'link.pdf'], since: 0 });
  assert.equal(declared.source, 'declared'); assert.deepEqual(declared.files.map(f => path.basename(f)), ['a.pdf']);
  const scanned = collectDeliverables({ workspace, declared: [], since: Date.now() - 60000 });
  assert.equal(scanned.source, 'scan'); assert.deepEqual(scanned.files.map(f => path.relative(fs.realpathSync(workspace), fs.realpathSync(f))), ['out/a.pdf']);
  assert.deepEqual(collectDeliverables({ workspace, declared: [], since: Date.now() + 60000 }).files, []);
});

test('the execution worker reports declared deliverables from the runtime JSONL stream', async t => {
  const root = temp(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace);
  const bin = path.join(root, 'fake-runtime');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('report.pdf', 'pdf');
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'tool_use', toolName: 'task_journal', toolInput: { kind: 'artifact', paths: ['report.pdf', '/etc/hosts'] }, sessionId: 's' });
out({ type: 'result', isError: false, subtype: 'success', result: 'done', sessionId: 's' });
`, { mode: 0o700 });
  const { atomicWrite, readState } = await import('../src/durable-store.mjs');
  const { runWorker } = await import('../src/execution-worker.mjs');
  const dir = path.join(root, 'e-1');
  atomicWrite(path.join(dir, 'request.json'), { id: 'e-1', kind: 'auto', mode: 'auto', intent: 'new', prompt: 'work', workspace, runtime: { bin } });
  await runWorker(dir);
  const result = readState(path.join(dir, 'result.json'), null);
  assert.equal(result.text, 'done'); assert.equal(result.deliverables.source, 'declared');
  assert.deepEqual(result.deliverables.files.map(f => path.basename(f)), ['report.pdf']);
});
