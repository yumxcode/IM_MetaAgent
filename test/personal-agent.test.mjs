import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalAgent, parseAutoRequest } from '../src/personal-agent.mjs';
import { atomicWrite, identityOf } from '../src/durable-store.mjs';
import { validateProjectName, containedDirectory } from '../src/project-store.mjs';

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-personal-'));
  const sent = [], launches = []; let seq = 0, time = 1000;
  const options = { root, cfg: { allowFrom: ['u', 'u2'], groupTrigger: 'off', maxConcurrent: 2 },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }) },
    bot: { async sendText(msg) { sent.push(msg); return { messageId: msg.clientId }; } },
    launcher: dir => { launches.push(dir); }, now: () => time, ...extra };
  let app = new PersonalAgent(options);
  const msg = (commandText, overrides = {}) => ({ accountId: 'b', fromUserId: 'u', messageId: String(++seq), contextToken: 'token', commandText, text: commandText, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Independent delegation helper: use actual standalone enter/body/exit messages.
  const send = (kind, body, overrides = {}) => {
    const current = app.store.state.modes[identityOf(msg('', overrides))];
    if (current) app.accept(msg(`${current.kind}/`, overrides));
    app.accept(msg(`/${kind}`, overrides));
    app.accept(msg(body || 'help', overrides));
  };
  return { root, sent, launches, msg, send, get app() { return app; }, advance(ms) { time += ms; },
    async restart() { await app.close(); app = new PersonalAgent(options); return app; },
    finish(index, result = {}) { const dir = launches[index], request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json')));
      atomicWrite(path.join(dir, 'result.json'), { ok: true, text: '完成结果', sessionId: `session-${index}`, requestId: request.id, ...result }); } };
}

test('idle content and old inline envelopes never execute', async t => {
  const f = fixture(t);
  for (const value of ['你好', '/auto 工作', '/talk 你好 auto/', '/p rm a', '/human 提交', '/talk talk/']) f.app.accept(f.msg(value));
  await f.app.tick(); await f.app.flushOutbox();
  assert.equal(f.launches.length, 0); assert.equal(Object.keys(f.app.store.state.tasks).length, 0); assert.ok(f.sent.length);
});

test('a new auto request always creates a separate goal; talk history is isolated', async t => {
  const f = fixture(t);
  f.send('auto', '整理资料'); f.send('auto', '分析表格'); f.send('talk', '你好');
  await f.app.tick();
  const state = f.app.store.state;
  assert.equal(state.tasks.A1.goal, '整理资料'); assert.equal(state.tasks.A2.goal, '分析表格');
  assert.notEqual(state.tasks.A1.workspace, state.tasks.A2.workspace);
  assert.equal(f.launches.length, 2);
  for (const e of Object.values(state.executions).filter(e => e.kind === 'auto')) { assert.equal(e.intent, 'new'); assert.equal(e.resumeSessionId, undefined); }
  const talk = Object.values(state.executions).find(e => e.kind === 'talk'); assert.equal(talk.status, 'queued');
  f.finish(0); await f.app.tick(); assert.equal(f.launches.length, 3);
  assert.notEqual(talk.workspace, state.tasks.A1.workspace);
});

test('a second talk turn waits for the first and uses its history; tasks control bypasses work capacity', async t => {
  const f = fixture(t, { cfg: { allowFrom: ['u'], maxConcurrent: 1 } });
  f.app.accept(f.msg('/talk')); f.app.accept(f.msg('第一条')); f.app.accept(f.msg('第二条')); f.send('tasks', '列出任务');
  await f.app.tick(); assert.equal(f.launches.length, 2);
  const executions = Object.values(f.app.store.state.executions);
  assert.equal(executions.filter(e => e.kind === 'talk' && e.status === 'running').length, 1);
  assert.equal(executions[0].historyFile, executions[1].historyFile);
  assert.equal(executions.find(e => e.kind === 'tasks').status, 'running');
});

test('accepted messages survive restart and duplicates never create a second execution', async t => {
  const f = fixture(t); f.app.accept(f.msg('/auto')); const original = f.msg('工作');
  f.app.accept(original); await f.restart(); f.app.accept(original); await f.app.tick();
  assert.equal(Object.keys(f.app.store.state.tasks).length, 1); assert.equal(f.launches.length, 1);
  atomicWrite(path.join(f.launches[0], 'started.json'), { pid: process.pid });
  await f.restart(); await f.app.tick(); assert.equal(f.launches.length, 1);
  f.finish(0); await f.app.tick(); await f.app.flushOutbox();
  const count = f.sent.length;
  await f.restart(); f.app.accept(original); await f.app.tick(); await f.app.flushOutbox();
  assert.equal(f.sent.length, count); assert.equal(f.launches.length, 1);
});

test('outbox retries the same client id after restart and refreshes the token', async t => {
  let fail = true; const sends = [];
  const f = fixture(t, { bot: { async sendText(msg) { sends.push(msg); if (fail) throw new Error('offline'); return { messageId: 'sent' }; } } });
  f.app.accept(f.msg('缺标记')); await f.app.flushOutbox(); assert.equal(sends.length, 1);
  await f.restart(); fail = false;
  f.send('human', 'help', { contextToken: 'new-token' }); await f.app.flushOutbox();
  assert.equal(sends[1].clientId, sends[0].clientId); assert.equal(sends[1].contextToken, 'new-token');
});

test('follow-up preserves sapiens mode and explicit continue/steer intent', async t => {
  const f = fixture(t); f.app.setHumanTasks({ observe() {}, rememberOrigin() {} });
  f.send('auto', '--sapiens 测试设备'); await f.app.tick(); f.finish(0); await f.app.tick();
  f.send('auto', '--steer A1 先检查电源'); await f.app.tick();
  const second = JSON.parse(fs.readFileSync(path.join(f.launches[1], 'request.json')));
  assert.equal(second.mode, 'sapiens'); assert.equal(second.intent, 'steer'); assert.equal(second.resumeSessionId, 'session-0');
  assert.equal(second.prompt, '先检查电源');
  assert.deepEqual(parseAutoRequest('--continue A1'), { intent: 'continue', target: 'A1', prompt: '' });
  assert.throws(() => parseAutoRequest('--continue A1 新目标'));
});

test('account and user scopes cannot inspect each other or share talk history', async t => {
  const f = fixture(t);
  f.send('auto', '私人工作'); await f.app.tick();
  f.send('tasks', 'inspect A1', { fromUserId: 'u2' });
  f.send('talk', '你好'); f.send('talk', '你好', { accountId: 'b2' });
  await f.app.tick(); await f.app.flushOutbox();
  assert.ok(f.sent.some(s => s.to === 'u2' && /不属于/.test(s.text)));
  const talks = Object.values(f.app.store.state.executions).filter(e => e.kind === 'talk');
  assert.notEqual(talks[0].historyFile, talks[1].historyFile);
});

test('human draft answers require human mode and talk never reaches the human form', async t => {
  const f = fixture(t), human = [];
  f.app.setHumanTasks({ observe() {}, async handleInMode(msg, body) { human.push(body); } });
  f.app.accept(f.msg('是')); f.send('human', '是'); f.send('talk', '不要回填');
  await f.app.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(human, ['是']);
  assert.equal(Object.values(f.app.store.state.executions).filter(e => e.kind === 'talk').length, 1);
});

test('uploaded files survive temporary-cache deletion and bind only within their conversation', async t => {
  const f = fixture(t), source = path.join(f.root, 'file.txt'); fs.writeFileSync(source, 'input');
  f.app.accept(f.msg('', { mediaPath: source, fileName: 'report.txt', mediaItem: { type: 4 } }));
  fs.unlinkSync(source);
  await f.restart();
  f.send('auto', '处理文件', { fromUserId: 'u2' }); f.send('auto', '总结附件');
  await f.app.tick();
  const tasks = Object.values(f.app.store.state.executions);
  assert.doesNotMatch(tasks[0].prompt, /用户附件/); assert.match(tasks[1].prompt, /用户附件/);
  const file = tasks[1].prompt.match(/文件：([^\n]+)/)[1]; assert.equal(fs.readFileSync(file, 'utf8'), 'input');
});

test('projects reject traversal, serialize shared writes and cannot archive during a run', async t => {
  const f = fixture(t);
  for (const bad of ['..', '../outside', '/tmp/test', 'a/b', 'a\\b', '.hidden']) assert.throws(() => validateProjectName(bad));
  f.send('tasks', 'project new 项目'); await f.app.tick();
  f.send('auto', '工作一'); f.send('auto', '工作二'); await f.app.tick();
  assert.equal(f.launches.length, 1);
  f.send('tasks', 'project archive 项目'); await f.app.tick(); await f.app.flushOutbox();
  await f.app.flushOutbox(); assert.ok(f.sent.some(s => /暂不能归档/.test(s.text)));
  f.finish(0); await f.app.tick(); assert.equal(f.launches.length, 2);
});

test('dead worker is unknown, never replayed, and preserves the captured session', async t => {
  const f = fixture(t); f.send('auto', '外部写操作'); await f.app.tick();
  atomicWrite(path.join(f.launches[0], 'started.json'), { pid: 2147483647 });
  atomicWrite(path.join(f.launches[0], 'session.json'), { sessionId: 'recoverable' });
  await f.restart(); await f.app.tick(); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A1.status, 'unknown'); assert.equal(f.app.store.state.tasks.A1.sessionId, 'recoverable');
  assert.equal(f.launches.length, 1);
});

test('a dispatch-before-spawn crash may relaunch the exclusive worker, not a fresh task', async t => {
  const f = fixture(t); f.send('auto', '工作'); await f.app.tick();
  await f.restart(); f.advance(10001); await f.app.tick();
  assert.equal(f.launches.length, 2); assert.equal(f.launches[0], f.launches[1]);
  assert.equal(Object.keys(f.app.store.state.tasks).length, 1);
});

test('cancellation of queued work never launches it; active cancellation is durably requested', async t => {
  const f = fixture(t, { cfg: { maxConcurrent: 1 } });
  f.send('auto', '一'); f.send('auto', '二'); await f.app.tick();
  f.send('tasks', 'cancel A2'); f.send('tasks', 'cancel A1'); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A2.status, 'cancelled'); assert.equal(f.launches.length, 1);
  assert.ok(fs.existsSync(path.join(f.launches[0], 'cancel.json')));
});

test('corrupt durable state fails closed and a second consumer cannot open the same store', async t => {
  const f = fixture(t);
  assert.throws(() => new PersonalAgent({ root: f.root, bot: {} }), /重复启动/);
  await f.app.close(); fs.writeFileSync(path.join(f.root, 'state.json'), '{bad');
  assert.throws(() => new PersonalAgent({ root: f.root, bot: {} }), /JSON|property|position/);
});


test('host path validation refuses a symlink before creating anything outside the root', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'im-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, 'linked'));
  assert.throws(() => containedDirectory(f.root, path.join(f.root, 'linked', 'should-not-exist')), /符号链接/);
  assert.equal(fs.existsSync(path.join(outside, 'should-not-exist')), false);
});

test('talk rejects nonimage files with guidance instead of silently dropping them', async t => {
  const f = fixture(t), media = path.join(f.root, 'document.pdf'); fs.writeFileSync(media, 'test');
  f.send('talk', '总结文件', { mediaPath: media, fileName: 'document.pdf' });
  await f.app.tick(); await f.app.flushOutbox();
  assert.equal(f.launches.length, 0); assert.ok(f.sent.some(s => /处理文档/.test(s.text)));
});


test('dead consumer lock is recovered, but a malformed owner is never silently stolen', async t => {
  const f = fixture(t); await f.app.close();
  atomicWrite(path.join(f.root, 'consumer.lock'), { pid: 2147483647, token: 'dead-consumer' });
  await f.restart(); assert.equal(f.app.store.state.version, 1);
  await f.app.close();
  atomicWrite(path.join(f.root, 'consumer.lock'), { pid: 'invalid' });
  assert.throws(() => new PersonalAgent({ root: f.root, bot: {} }), /锁记录损坏/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'consumer.lock'))).pid, 'invalid');
});


test('a refused recovery keeps later work in the same project fenced', async t => {
  const f = fixture(t);
  f.send('tasks', 'project new recovery'); await f.app.tick();
  f.send('auto', '原工作'); await f.app.tick();
  atomicWrite(path.join(f.launches[0], 'started.json'), { pid: 2147483647 });
  atomicWrite(path.join(f.launches[0], 'session.json'), { sessionId: 'recoverable' });
  await f.app.tick();
  f.send('auto', '新工作');
  f.send('auto', '--continue A1'); await f.app.tick();
  assert.equal(f.launches.length, 2);
  f.finish(1, { ok: false, subtype: 'worker_error', text: 'runtime still running' }); await f.app.tick();
  assert.equal(f.launches.length, 2); assert.equal(f.app.store.state.tasks.A2.status, 'queued');
  f.send('auto', '--continue A1'); await f.app.tick();
  assert.equal(f.launches.length, 3);
  f.finish(2, { recoveryValidated: true }); await f.app.tick();
  assert.equal(f.launches.length, 4); assert.equal(f.app.store.state.tasks.A2.status, 'running');
});

test('a dead chat or operations worker does not block a new explicit conversation turn', async t => {
  const f = fixture(t);
  for (const [kind, body] of [['talk', '你好'], ['tasks', '查看']]) {
    f.send(kind, body); await f.app.tick();
    const previous = f.launches.length;
    atomicWrite(path.join(f.launches.at(-1), 'started.json'), { pid: 2147483647 });
    await f.app.tick();
    f.send(kind, body); await f.app.tick();
    assert.equal(f.launches.length, previous + 1);
    f.finish(f.launches.length - 1); await f.app.tick();
  }
});

test('standalone entry acknowledges once, ordinary turns share a mode, and only its own exit works', async t => {
  const f = fixture(t);
  f.app.accept(f.msg('/tasks')); await f.app.tick(); await f.app.flushOutbox();
  assert.equal(f.launches.length, 0); assert.match(f.sent.at(-1).text, /已进入任务运维模式/);
  const owner = identityOf(f.msg('')), session = f.app.store.state.modes[owner].sessionId;
  f.app.accept(f.msg('查看任务')); f.app.accept(f.msg('展开第一个'));
  for (const text of ['auto/', '/talk', '/tasks']) f.app.accept(f.msg(text));
  assert.equal(f.app.store.state.modes[owner].sessionId, session);
  await f.app.tick();
  const jobs = Object.values(f.app.store.state.executions);
  assert.equal(jobs.length, 2); assert.equal(jobs[0].opsRoot, jobs[1].opsRoot);
  f.app.accept(f.msg('tasks/')); f.app.accept(f.msg('退出后不执行'));
  assert.equal(f.app.store.state.modes[owner], undefined);
  await f.app.tick(); assert.equal(Object.keys(f.app.store.state.executions).length, 2);
  await f.app.flushOutbox(); assert.ok(f.sent.some(s => /已退出任务运维模式/.test(s.text)));
});

test('mode selection survives restart and duplicate transport messages cannot reenter or exit a later mode', async t => {
  const f = fixture(t), enter = f.msg('/talk'), leave = f.msg('talk/'), owner = identityOf(enter);
  f.app.accept(enter); await f.restart();
  assert.equal(f.app.store.state.modes[owner].kind, 'talk');
  f.app.accept(f.msg('记住上文')); await f.app.tick(); assert.equal(f.launches.length, 1);
  f.app.accept(leave); f.app.accept(f.msg('/auto')); const current = f.app.store.state.modes[owner].sessionId;
  f.app.accept(enter); f.app.accept(leave);
  assert.equal(f.app.store.state.modes[owner].sessionId, current);
});

test('mode state is isolated by bot, user and group; quoted markers are inert', async t => {
  const f = fixture(t, { cfg: { allowFrom: ['u', 'u2'], groupTrigger: 'prefix' } });
  f.app.accept(f.msg('/talk'));
  for (const extra of [{ accountId: 'b2' }, { fromUserId: 'u2' }, { groupId: 'group' }]) f.app.accept(f.msg('不能借用模式', extra));
  f.app.accept(f.msg('解释这段话', { quoteContext: 'talk/\n/auto' }));
  await f.app.tick(); assert.equal(f.launches.length, 1);
  assert.equal(Object.values(f.app.store.state.modes).length, 1);
  assert.equal(Object.values(f.app.store.state.executions)[0].kind, 'talk');
});

test('plain auto follow-ups queue against the same task and resume its runtime context in order', async t => {
  const f = fixture(t);
  f.app.accept(f.msg('/auto')); f.app.accept(f.msg('整理资料')); f.app.accept(f.msg('先处理第一章')); f.app.accept(f.msg('最后给出摘要'));
  await f.app.tick(); assert.equal(f.launches.length, 1); assert.equal(Object.keys(f.app.store.state.tasks).length, 1);
  f.finish(0); await f.restart(); await f.app.tick(); await f.app.tick();
  assert.equal(f.launches.length, 2);
  const second = JSON.parse(fs.readFileSync(path.join(f.launches[1], 'request.json')));
  assert.equal(second.taskId, 'A1'); assert.equal(second.intent, 'steer'); assert.equal(second.resumeSessionId, 'session-0'); assert.equal(second.prompt, '先处理第一章');
  f.finish(1); await f.app.tick(); await f.app.tick();
  const third = JSON.parse(fs.readFileSync(path.join(f.launches[2], 'request.json')));
  assert.equal(third.taskId, 'A1'); assert.equal(third.prompt, '最后给出摘要'); assert.equal(Object.keys(f.app.store.state.tasks).length, 1);
  f.app.accept(f.msg('auto/')); f.app.accept(f.msg('/auto')); f.app.accept(f.msg('另一个目标')); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A2.goal, '另一个目标');
});

test('exiting before dispatch preserves the accepted message route and does not cancel work', async t => {
  const f = fixture(t);
  f.app.accept(f.msg('/auto')); f.app.accept(f.msg('已交办工作')); f.app.accept(f.msg('auto/'));
  f.app.accept(f.msg('/talk')); f.app.accept(f.msg('闲聊')); await f.app.tick();
  assert.equal(f.launches.length, 2);
  assert.equal(f.app.store.state.tasks.A1.status, 'running');
  assert.deepEqual(Object.values(f.app.store.state.executions).map(e => e.kind), ['auto', 'talk']);
});

test('a file inside human mode reaches its form without inline markers', async t => {
  const f = fixture(t), answers = [], file = path.join(f.root, 'answer.txt'); fs.writeFileSync(file, 'answer');
  f.app.setHumanTasks({ observe() {}, async handleInMode(msg, body) { answers.push({ body, path: msg.mediaPath }); } });
  f.app.accept(f.msg('/human')); f.app.accept(f.msg('', { mediaPath: file, fileName: 'answer.txt', mediaItem: { type: 4 } }));
  await f.app.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(answers[0].body, '附件'); assert.equal(fs.readFileSync(answers[0].path, 'utf8'), 'answer');
});

test('talk and tasks reentry create fresh history even when old accepted work is still queued', async t => {
  const f = fixture(t);
  for (const kind of ['talk', 'tasks']) {
    f.send(kind, '第一段'); f.send(kind, '第二段');
  }
  await f.app.tick();
  const jobs = Object.values(f.app.store.state.executions);
  const talks = jobs.filter(e => e.kind === 'talk'), ops = jobs.filter(e => e.kind === 'tasks');
  assert.notEqual(talks[0].historyFile, talks[1].historyFile);
  assert.notEqual(ops[0].opsRoot, ops[1].opsRoot);
  assert.ok(Object.values(f.app.store.state.modeSessions).filter(s => s.closedAt != null).length >= 3);
});

test('auto reentry can select an existing task without running it and keeps pending text on its original task', async t => {
  const f = fixture(t);
  f.send('auto', '任务一'); f.send('auto', '任务二'); await f.app.tick();
  f.finish(1); await f.app.tick();
  f.app.accept(f.msg('auto/')); f.app.accept(f.msg('/auto'));
  f.app.accept(f.msg('A1')); await f.app.tick(); assert.equal(f.launches.length, 2);
  f.app.accept(f.msg('给任务一的补充')); f.app.accept(f.msg('选择 A2')); f.app.accept(f.msg('给任务二的补充'));
  await f.app.tick(); assert.equal(f.launches.length, 3);
  const third = JSON.parse(fs.readFileSync(path.join(f.launches[2], 'request.json')));
  assert.equal(third.taskId, 'A2'); assert.equal(third.resumeSessionId, 'session-1');
  f.finish(0); await f.app.tick(); await f.app.tick();
  const fourth = JSON.parse(fs.readFileSync(path.join(f.launches[3], 'request.json')));
  assert.equal(fourth.taskId, 'A1'); assert.equal(fourth.prompt, '给任务一的补充');
  const mode = f.app.store.state.modes[identityOf(f.msg(''))];
  assert.equal(f.app.store.state.modeSessions[mode.sessionId].taskId, 'A2');
  f.app.accept(f.msg('新建')); f.app.accept(f.msg('第三个目标')); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A3.goal, '第三个目标');
});

test('auto selection cannot access another user task', async t => {
  const f = fixture(t); f.send('auto', '私人工作'); await f.app.tick();
  f.send('auto', 'A1', { fromUserId: 'u2' }); await f.app.tick();
  assert.equal(f.launches.length, 1);
  assert.ok(Object.values(f.app.store.state.outbox).some(m => /不属于/.test(m.text)));
});

test('task navigation does not consume an attachment awaiting a work instruction', async t => {
  const f = fixture(t), file = path.join(f.root, 'input.txt'); fs.writeFileSync(file, 'content');
  f.app.accept(f.msg('', { mediaPath: file, fileName: 'input.txt', mediaItem: { type: 4 } }));
  f.app.accept(f.msg('/auto')); f.app.accept(f.msg('列表')); f.app.accept(f.msg('新建')); f.app.accept(f.msg('总结附件'));
  await f.app.tick(); assert.equal(f.launches.length, 1);
  const request = JSON.parse(fs.readFileSync(path.join(f.launches[0], 'request.json')));
  assert.match(request.prompt, /用户附件/);
});
