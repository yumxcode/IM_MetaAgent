import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalAgent, chunks, statusNotice, goalTitle, resultHead, resultBody } from '../src/personal-agent.mjs';

// The brief an assistant writes for an auto task: thousands of characters, many lines.
const BRIEF = ['X1 29DOF supermimic 第二阶段（修订版）：先修好 GMR 手臂重定向质量 → 下载数据 → 训练。', '',
  ...Array.from({ length: 40 }, (_, i) => `${i + 1}. 第 ${i + 1} 项要求：路径 ~/code/X1_29_AMP/data/part${i}，这里是很长的一段说明文字，用来把消息撑过单条上限。`)].join('\n');

test('a short reply stays one part without a counter', () => {
  assert.deepEqual(chunks('你好'), ['你好']);
  assert.deepEqual(chunks(''), ['（没有文本结果）']);
  assert.equal(chunks('x'.repeat(2600)).length, 1);
});

test('a long reply splits at line breaks, numbers its parts and loses no content', () => {
  const text = BRIEF + '\n' + BRIEF;
  const parts = chunks(text);
  assert.ok(parts.length >= 2);
  parts.forEach((part, i) => {
    assert.ok(Array.from(part).length <= 2600, `part ${i} fits`);
    assert.ok(part.endsWith(`（${i + 1}/${parts.length}）`));
  });
  const bodies = parts.map(p => p.replace(/\n（\d+\/\d+）$/u, ''));
  // Every cut lands on a line boundary: each body ends a full line of the original.
  for (const body of bodies.slice(0, -1)) assert.ok(text.includes(body + '\n'), 'cut at a line break');
  assert.equal(bodies.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
  assert.ok(!parts.some(p => /~\/code\/X1_29\n/.test(p)), 'no path cut in half');
});

test('prose without line breaks splits after a sentence; one endless token still hard-cuts', () => {
  const prose = '这是一句完整的话，用于测试分段效果。'.repeat(300);
  const parts = chunks(prose);
  for (const part of parts.slice(0, -1)) assert.match(part, /。\n（\d+\/\d+）$/u);
  const token = 'a'.repeat(6000);
  const hard = chunks(token);
  assert.equal(hard.map(p => p.replace(/\n（\d+\/\d+）$/u, '')).join(''), token);
  assert.ok(hard.every(p => p.length <= 2600));
});

test('splitting never breaks a surrogate pair', () => {
  const parts = chunks('😀'.repeat(5000));
  for (const part of parts) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(part));
});

test('status notice names the task by its first line and never carries the whole brief', () => {
  assert.equal(goalTitle('\n  第一行  \n第二行'), '第一行');
  const notice = statusNotice({ id: 'A3', goal: BRIEF }, 'finished', { note: '训练完成，报告在 docs/' });
  assert.ok(notice.length < 400, `short: ${notice.length}`);
  assert.match(notice, /^【A3·状态】任务已在后台结束（runtime：finished）/);
  assert.match(notice, /任务：X1 29DOF supermimic/);
  assert.match(notice, /说明：训练完成，报告在 docs\//);
  assert.match(notice, /详情：\/tasks inspect A3$/);
  assert.ok(!notice.includes('第 2 项要求'));
  assert.match(statusNotice({ id: 'A4', goal: 'g' }, 'failed', { stopReason: 'error' }), /后台执行失败[\s\S]*原因：error/);
});

function syncFixture(t, views) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-status-'));
  const source = { views };
  const app = new PersonalAgent({ root, adapter: { settings: () => ({ bin: 'fake' }) }, bot: {}, cfg: { allowFrom: ['u'] },
    taskSource: { async list() { return source.views; } } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = { accountId: 'b', fromUserId: 'u' };
  const add = (id, extra = {}) => app.store.update(state => {
    state.tasks[id] = { id, workspace: root, sessionId: `s-${id}`, goal: BRIEF, origin, status: 'succeeded', lastActivityAt: Date.now(), ...extra }; });
  const outbox = () => Object.values(app.store.state.outbox).map(o => o.text);
  return { app, root, source, add, outbox };
}

test('a run already reported by 【结果】 does not get a second 【状态】 when the runtime finishes', async t => {
  const f = syncFixture(t, []);
  f.add('A3', { status: 'running' });
  f.source.views = [{ workspace: f.root, sessionId: 's-A3', status: 'running' }];
  await f.app.syncTasks();
  // The IM execution settles and sends 【A3·结果】.
  f.app.store.update(state => { Object.assign(state.tasks.A3, { status: 'succeeded', resultNotifiedAt: Date.now() + 1 }); });
  f.source.views = [{ workspace: f.root, sessionId: 's-A3', status: 'finished' }];
  await f.app.syncTasks();
  assert.equal(f.app.store.state.tasks.A3.runtimeState.status, 'finished');
  assert.deepEqual(f.outbox(), []);
});

test('the runtime finishing while the IM execution is still in flight leaves the report to 【结果】', async t => {
  const f = syncFixture(t, [{ status: 'running' }]);
  f.add('A5', { status: 'running', runtimeState: { status: 'running' } });
  f.source.views = [{ workspace: f.root, sessionId: 's-A5', status: 'finished' }];
  await f.app.syncTasks();
  assert.deepEqual(f.outbox(), []);
});

test('a task the runtime resumed and finished on its own gets one short 【状态】', async t => {
  const f = syncFixture(t, []);
  f.add('A6', { resultNotifiedAt: 1, runtimeState: { status: 'needs-decision' } });
  f.source.views = [{ workspace: f.root, sessionId: 's-A6', status: 'running' }];
  await f.app.syncTasks();
  f.source.views = [{ workspace: f.root, sessionId: 's-A6', status: 'finished', note: '全部完成' }];
  await f.app.syncTasks();
  const sent = f.outbox();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^【A6·状态】任务已在后台结束/);
  assert.match(sent[0], /说明：全部完成/);
  assert.ok(sent[0].length < 400);
});

test('end to end: an auto run sends one 【结果】 and the later runtime "finished" adds nothing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-status-e2e-'));
  const launches = [], views = [];
  const app = new PersonalAgent({ root, cfg: { allowFrom: ['u'], groupTrigger: 'off', maxConcurrent: 2 },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }) }, bot: {}, launcher: dir => { launches.push(dir); },
    taskSource: { async list() { return views; } } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.accept({ accountId: 'b', fromUserId: 'u', messageId: '1', contextToken: 'token', commandText: `/auto ${BRIEF}`, text: `/auto ${BRIEF}` });
  await app.tick();
  const task = app.store.state.tasks.A1;
  views.push({ workspace: task.workspace, sessionId: 'session-0', status: 'running' });
  const { atomicWrite } = await import('../src/durable-store.mjs');
  const request = JSON.parse(fs.readFileSync(path.join(launches[0], 'request.json')));
  atomicWrite(path.join(launches[0], 'result.json'), { ok: true, text: '训练完成，报告见 docs/X1_PHASE2_REPORT.md', sessionId: 'session-0', requestId: request.id });
  await app.tick();
  assert.ok(app.store.state.tasks.A1.resultNotifiedAt);
  views[0].status = 'finished';
  await app.syncTasks();
  const texts = Object.values(app.store.state.outbox).map(o => o.text);
  assert.equal(texts.filter(x => x.startsWith('【A1·结果】')).length, 1);
  assert.equal(texts.filter(x => x.startsWith('【A1·状态】')).length, 0);
  assert.ok(texts.find(x => x.startsWith('【A1·已开始】')).length < 400);
});

test('a parked run reads as "挂起，约 N 后继续" instead of the raw park line', () => {
  const parked = { ok: true, subtype: 'parked', text: 'Auto session parked for 3000000ms: P3 v6 启动；50 分钟后验证修复是否生效。' };
  assert.equal(resultHead(parked), '本次执行已挂起，约 50 分钟后由 runtime 自动继续');
  assert.equal(resultBody(parked), 'P3 v6 启动；50 分钟后验证修复是否生效。');
  assert.equal(resultHead({ ok: true, subtype: 'parked', text: 'Auto session parked for 7200000ms: x' }), '本次执行已挂起，约 2 小时后由 runtime 自动继续');
  assert.equal(resultHead({ ok: true, subtype: 'success' }), '本次执行已返回');
  assert.equal(resultHead({ ok: false, subtype: 'error_max_turns' }), '本次执行未完成');
  assert.equal(resultBody({ ok: true, subtype: 'success', text: 'Auto session parked for 1ms: kept' }), 'Auto session parked for 1ms: kept');
});

test('an execution the runtime took over sends one labelled line (none for an assistant tool) and leaves the outcome to syncTasks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-handoff-'));
  const launches = [];
  const app = new PersonalAgent({ root, cfg: { allowFrom: ['u'], groupTrigger: 'off', maxConcurrent: 2 },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }) }, bot: {}, launcher: dir => { launches.push(dir); } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { atomicWrite, identityOf } = await import('../src/durable-store.mjs');
  const owner = identityOf({ accountId: 'b', fromUserId: 'u' });
  app.store.update(state => { state.tasks.A1 = { id: 'A1', owner, goal: '训练', workspace: root, sessionId: 's1', status: 'succeeded', mode: 'auto', runtime: { bin: 'fake' }, resultNotifiedAt: 1 }; });
  app.accept({ accountId: 'b', fromUserId: 'u', messageId: '1', contextToken: 'token', commandText: '/auto --continue A1', text: '/auto --continue A1' });
  await app.tick();
  assert.equal(launches.length, 1);
  const request = JSON.parse(fs.readFileSync(path.join(launches[0], 'request.json')));
  atomicWrite(path.join(launches[0], 'result.json'), { ok: true, subtype: 'handed_off', text: 'runtime 已恢复执行（tasks 中显示为运行）。', sessionId: 's1', handoff: { from: 'parked', steered: false, state: 'running' }, requestId: request.id });
  await app.tick();
  const task = app.store.state.tasks.A1;
  assert.equal(task.status, 'handed_off'); assert.equal(task.resultNotifiedAt, 1, 'the runtime turn is not reported yet');
  const texts = Object.values(app.store.state.outbox).map(o => o.text).filter(x => x.startsWith('【A1·'));
  assert.deepEqual(texts.filter(x => !x.startsWith('【A1·已开始】')), ['【A1·继续】runtime 已恢复执行（tasks 中显示为运行）。']);
});
