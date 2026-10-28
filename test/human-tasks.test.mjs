import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHumanTasks, loadHumanDefaultRecipient, loadHumanRoutes, parseHumanValue } from '../src/human-tasks.mjs';
import { createHumanTaskApi } from '../src/human-task-api.mjs';
import { parseAgentTrigger } from '../src/message-trigger.mjs';

const ID = 'ht-0123456789abcdef';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const beforeNextTurn = promise => Promise.race([promise, new Promise(resolve => setImmediate(() => resolve('blocked')))]);

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'im-human-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const task = { taskId: ID, workspace: directory, sessionId: 'session-1', title: '检查急停', why: '测试',
    steps: ['手持急停'], safety: ['异常立即停止'], requiredOutputs: [{ name: 'safe', type: 'bool', required: true }],
    assigneeRole: '操作员', status: 'pending', deliveries: [], priority: 'high', waitMode: 'blocking', deadlineAt: Date.now() + 100000, ...overrides };
  const calls = [], sent = [], replies = [], events = [], memo = new Map();
  let failures = {}, count = 0, time = Date.now();
  const api = async (name, input) => {
    calls.push({ name, input: structuredClone(input) });
    if (failures[name]) { failures[name]--; throw new Error('temporary failure'); }
    if (input.requestId && memo.has(input.requestId)) return memo.get(input.requestId);
    let result;
    if (name === 'human_task.events') result = { data: { events: events.slice(input.cursor), nextCursor: events.length } };
    else if (name === 'human_task.list') result = { data: { tasks: ['pending', 'delivered', 'acked'].includes(task.status) ? [structuredClone(task)] : [] }, page: { cursor: null } };
    else if (name === 'human_task.inspect') result = { data: { task: structuredClone(task), inbox: path.join(directory, 'inbox') } };
    else if (name === 'task.inspect') result = { data: { task: { status: 'parked' } } };
    else {
      if (name === 'human_task.deliver') { task.status = 'delivered'; task.deliveries.push(input); }
      if (name === 'human_task.ack') task.status = 'acked';
      if (name === 'human_task.complete') task.status = 'done';
      if (name === 'human_task.reject') task.status = 'rejected';
      result = { data: { task: structuredClone(task) } };
    }
    if (input.requestId) memo.set(input.requestId, result);
    return result;
  };
  const route = { workspace: directory, role: '操作员', accountId: 'bot-1', userId: 'person-1' };
  const options = { stateDir: directory, routes: [route], api, now: () => time, log: { warn() {} },
    bot: { async sendText(msg) { sent.push(msg); return { messageId: `m${sent.length}` }; }, async reply(msg, text) { replies.push({ msg, text }); } } };
  const make = (extra = {}) => createHumanTasks({ ...options, ...extra });
  const msg = (text, extra = {}) => ({ accountId: 'bot-1', fromUserId: 'person-1', messageId: String(++count), contextToken: 'token', commandText: text, ...extra });
  return { directory, task, route, api, options, make, msg, sent, replies, calls, events,
    fail(name) { failures[name] = 1; }, advance(ms = 60000) { time += ms; } };
}

test('gateway uses fixed arguments, only approves supported writes and checks envelope', async () => {
  const calls = [];
  const api = createHumanTaskApi({ env: { META_AGENT_HUMAN_BIN: '/custom/runtime' }, run: async (...args) => {
    calls.push(args); return { code: 0, stdout: '{"ok":true,"data":{}}' };
  } });
  await api('human_task.list', { open: true });
  await api('human_task.reject', { reason: '$(echo secret); `touch nope`' });
  assert.equal(calls[0][0], '/custom/runtime');
  assert.equal(calls[0][1].includes('--yes'), false);
  assert.equal(calls[1][1].at(-1), '--yes');
  assert.equal(JSON.parse(calls[1][1][3]).reason, '$(echo secret); `touch nope`');
  await assert.rejects(api('task.run', {}), /Unsupported/);
  const bad = createHumanTaskApi({ run: async () => ({ code: 1, stdout: '{"ok":false,"error":{"code":"INVALID_ARGUMENT","message":"bad"}}' }) });
  await assert.rejects(bad('human_task.list', {}), e => e.code === 'INVALID_ARGUMENT');
});

test('sapiens and human commands respect allowlist; ordinary commands retain semantics', () => {
  const cfg = { allowFrom: ['u'], groupTrigger: 'off', triggerPrefix: '/' };
  const msg = commandText => ({ commandText, fromUserId: 'u' });
  assert.equal(parseAgentTrigger(msg('--sapiens 验证步态'), cfg, { kind: 'auto', sessionId: 's' }).action, 'auto');
  assert.equal(parseAgentTrigger(msg('H1 填写'), cfg, { kind: 'human', sessionId: 's' }).action, 'human');
  assert.equal(parseAgentTrigger({ ...msg('/human'), fromUserId: 'other' }, cfg).action, 'ignore');
  assert.equal(parseAgentTrigger(msg('测试'), cfg, { kind: 'auto', sessionId: 's' }).action, 'auto');
});

test('notification waits for contact, persists token, retries registration without resending after restart', async t => {
  const f = fixture(t), service = f.make();
  await service.tick(); assert.equal(f.sent.length, 0);
  assert.equal(await service.handle(f.msg('你好')), false);
  f.fail('human_task.deliver'); await service.tick();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /异常立即停止/);
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, 'human-tasks.json')));
  assert.equal(state.tasks[ID].sent, true); assert.equal(state.tasks[ID].registered, undefined);
  f.advance(); const restarted = f.make(); await restarted.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.task.status, 'delivered');
  const deliveries = f.calls.filter(c => c.name === 'human_task.deliver');
  assert.deepEqual(deliveries[0].input, deliveries[1].input);
  assert.equal(fs.statSync(path.join(f.directory, 'human-tasks.json')).mode & 0o777, 0o600);
});

test('failed sends remain queued and retry after token refresh', async t => {
  const f = fixture(t); let attempts = 0;
  const service = f.make({ bot: { ...f.options.bot, async sendText(msg) {
    if (++attempts === 1) throw new Error('invalid token'); return f.options.bot.sendText(msg);
  } } });
  await service.handle(f.msg('hello')); await service.tick(); assert.equal(f.task.status, 'pending');
  await service.handle(f.msg('hello', { contextToken: 'new-token' })); await service.tick();
  assert.equal(f.sent[0].contextToken, 'new-token'); assert.equal(f.task.status, 'delivered');
});

test('role routing, origin fallback and account/user authorization', async t => {
  const f = fixture(t), service = f.make({ routes: [{ ...f.route, role: '其他角色' }] });
  service.rememberOrigin(f.task.workspace, f.task.sessionId, f.msg(''));
  await service.handle(f.msg('hello')); await service.tick();
  assert.equal(f.sent.length, 0, 'explicit role must not fall back to origin');
  delete f.task.assigneeRole; f.advance(); await service.tick(); assert.equal(f.sent.length, 1);
  await service.handle(f.msg('/human H1 填写', { fromUserId: 'stranger' }));
  assert.match(f.replies.at(-1).text, /无权访问/);
  await service.handle(f.msg('/human H1 填写', { accountId: 'other-bot' }));
  assert.match(f.replies.at(-1).text, /无权访问/);
  const restricted = f.make({ allowFrom: ['someone-else'] });
  assert.equal(await restricted.handle(f.msg('/human')), false);
});

test('default recipient uses the selected bot, supports overrides and rejects incomplete configuration', () => {
  assert.equal(loadHumanDefaultRecipient({}), null);
  assert.deepEqual(loadHumanDefaultRecipient({ META_AGENT_HUMAN_DEFAULT_USER_ID: ' owner ' }, 'selected-bot'), { accountId: 'selected-bot', userId: 'owner' });
  assert.deepEqual(loadHumanDefaultRecipient({ META_AGENT_HUMAN_DEFAULT_USER_ID: 'owner', WEIXIN_ACCOUNT_ID: 'env-bot' }, 'selected-bot'), { accountId: 'env-bot', userId: 'owner' });
  assert.deepEqual(loadHumanDefaultRecipient({ META_AGENT_HUMAN_DEFAULT_USER_ID: 'owner', META_AGENT_HUMAN_DEFAULT_ACCOUNT_ID: 'explicit-bot', WEIXIN_ACCOUNT_ID: 'env-bot' }, 'selected-bot'), { accountId: 'explicit-bot', userId: 'owner' });
  assert.throws(() => loadHumanDefaultRecipient({ META_AGENT_HUMAN_DEFAULT_ACCOUNT_ID: 'bot' }), /META_AGENT_HUMAN_DEFAULT_USER_ID/);
  assert.throws(() => loadHumanDefaultRecipient({ META_AGENT_HUMAN_DEFAULT_USER_ID: 'owner' }), /机器人账号/);
});

test('terminal and worker tasks with a role go to the global default without a project binding or origin', async t => {
  const f = fixture(t, { sessionId: undefined });
  const service = f.make({ routes: [], defaultRecipient: { accountId: 'bot-1', userId: 'person-1' } });
  await service.handle(f.msg('/human whoami')); await service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'person-1');
  assert.match(f.sent[0].text, /Agent 给你分配了任务/);
  assert.match(f.sent[0].text, /检查急停/);
  assert.equal(f.task.status, 'delivered');
  assert.match(await service.check(), /全项目默认收件人：person-1/);
  await service.handle(f.msg('/human H1', { fromUserId: 'stranger' }));
  assert.match(f.replies.at(-1).text, /无权访问/);
});

test('project role and project owner take precedence over the global default', async t => {
  for (const roleMatch of [true, false]) {
    const f = fixture(t);
    const service = f.make({ routes: [{ ...f.route, role: roleMatch ? '操作员' : '其他角色' }, { ...f.route, role: undefined, userId: 'project-owner' }],
      defaultRecipient: { accountId: 'bot-1', userId: 'global-owner' } });
    const expected = roleMatch ? 'person-1' : 'project-owner';
    await service.handle(f.msg('hello', { fromUserId: expected })); await service.tick();
    assert.equal(f.sent[0].to, expected);
    await service.handle(f.msg('/human H1 填写', { fromUserId: 'global-owner' }));
    assert.match(f.replies.at(-1).text, /无权访问/);
  }
});

test('default recipient respects the sender allowlist', t => {
  const f = fixture(t);
  assert.throws(() => f.make({ allowFrom: ['someone-else'], defaultRecipient: { accountId: 'bot-1', userId: 'person-1' } }), /WEIXIN_ALLOW_FROM/);
});

test('single-user mode binds from an ordinary private message and restores routing and token after restart', async t => {
  const f = fixture(t, { sessionId: undefined });
  let service = f.make({ routes: [] });
  assert.match(await service.check(), /等待你私聊/);
  await service.tick(); assert.equal(f.sent.length, 0);
  assert.equal(await service.handle(f.msg('你好')), false);
  await service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'person-1');
  assert.equal(f.task.status, 'delivered');
  assert.match(await service.check(), /自动识别/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'human-tasks.json'))).autoRecipient, { accountId: 'bot-1', userId: 'person-1' });

  await service.close();
  f.task.taskId = 'ht-1111111111111111'; f.task.status = 'pending'; f.task.deliveries = [];
  service = f.make({ routes: [] }); await service.tick();
  assert.equal(f.sent.length, 2, 'new worker task is delivered without another inbound message');
  assert.equal(f.sent[1].to, 'person-1');
  assert.equal(f.sent[1].contextToken, 'token');
});

test('an automatic binding is not replaced by a later sender or a different bot account', async t => {
  const f = fixture(t), service = f.make({ routes: [] });
  await service.handle(f.msg('hello'));
  await service.handle(f.msg('hello', { fromUserId: 'other-person' }));
  await service.handle(f.msg('hello', { accountId: 'other-bot' }));
  await service.tick();
  assert.equal(f.sent[0].to, 'person-1'); assert.equal(f.sent[0].accountId, 'bot-1');
  await service.handle(f.msg('/human H1 填写', { fromUserId: 'other-person' }));
  assert.match(f.replies.at(-1).text, /无权访问/);
});

test('groups, disallowed senders and messages without a context token do not bind the inbox', async t => {
  const f = fixture(t), service = f.make({ routes: [], allowFrom: ['person-1'] });
  await service.handle(f.msg('hello', { groupId: 'group' }));
  await service.handle(f.msg('hello', { fromUserId: 'other-person' }));
  await service.handle(f.msg('hello', { contextToken: undefined }));
  await service.tick(); assert.equal(f.sent.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'human-tasks.json'))).autoRecipient, undefined);
  await service.handle(f.msg('hello')); await service.tick();
  assert.equal(f.sent[0].to, 'person-1');
});

test('upgrade reuses a sole stored contact of the currently selected bot', async t => {
  const f = fixture(t), prior = f.make();
  await prior.handle(f.msg('hello'));
  await prior.handle(f.msg('hello', { accountId: 'other-bot' }));
  await prior.close();
  const service = f.make({ routes: [], bot: { ...f.options.bot, getDefaultAccount: () => 'bot-1' } });
  await service.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].accountId, 'bot-1');
  assert.match(await service.check(), /自动识别/);
});

test('ambiguous stored history waits for a private message instead of selecting an old contact', async t => {
  const f = fixture(t), prior = f.make();
  await prior.handle(f.msg('hello')); await prior.handle(f.msg('hello', { fromUserId: 'other-person' }));
  await prior.close();
  const service = f.make({ routes: [] });
  await service.tick(); assert.equal(f.sent.length, 0);
  await service.handle(f.msg('hello')); await service.tick();
  assert.equal(f.sent[0].to, 'person-1');
});

test('stalled runtime polling does not hold ordinary chat, identity lookup or token refresh', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const service = f.make({ api: async (name, input) => {
    if (name === 'human_task.events') { entered.resolve(); await release.promise; }
    return f.api(name, input);
  } });
  const ticking = service.tick();
  try {
    await entered.promise;
    assert.equal(await beforeNextTurn(service.handle(f.msg('你好', { contextToken: 'fresh-token' }))), false);
    assert.equal(await beforeNextTurn(service.handle(f.msg('/human whoami', { contextToken: 'fresh-token' }))), true);
    assert.match(f.replies.at(-1).text, /accountId: bot-1\nuserId: person-1/);
    assert.equal(await beforeNextTurn(service.handle(f.msg('/tasks 查看任务', { contextToken: 'fresh-token' }))), false);
  } finally { release.resolve(); await ticking; }
  assert.equal(f.sent[0].contextToken, 'fresh-token');
});

test('a stalled notification leaves ordinary commands available during a form', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const service = f.make({ bot: { ...f.options.bot, async sendText(msg) {
    entered.resolve(); await release.promise; return f.options.bot.sendText(msg);
  } } });
  await service.handle(f.msg('/human')); await service.handle(f.msg('/human H1 填写'));
  const ticking = service.tick();
  try {
    await entered.promise;
    for (const text of ['/tasks 查看任务', '/p', '/goal 测试', '/sapiens 测试', '/clear']) {
      assert.equal(await beforeNextTurn(service.handle(f.msg(text))), false, text);
    }
    assert.equal(await beforeNextTurn(service.handle(f.msg('/human whoami'))), true);
  } finally { release.resolve(); await ticking; }
  await service.handle(f.msg('是')); await service.handle(f.msg('提交'));
  assert.equal(f.task.status, 'done');
});

test('form requires explicit submit, handles duplicate field messages, and resumes draft after restart', async t => {
  const f = fixture(t); let service = f.make();
  await service.handle(f.msg('hello')); await service.tick();
  await service.handle(f.msg('/human H1 接单')); assert.equal(f.task.status, 'acked');
  await service.handle(f.msg('/human H1 填写'));
  await service.handle(f.msg('好了')); assert.match(f.replies.at(-1).text, /是 \/ 否/);
  const answer = f.msg('是'); await service.handle(answer); await service.handle(answer);
  assert.equal(f.task.status, 'acked'); assert.match(f.replies.at(-1).text, /回执摘要/);
  service = f.make(); await service.handle(f.msg('提交'));
  const call = f.calls.find(c => c.name === 'human_task.complete');
  assert.equal(call.input.actor, 'person-1'); assert.deepEqual(call.input.outputs, { safe: true });
  assert.equal(call.input.rawText, '是'); assert.equal(f.task.status, 'done');
  assert.match(f.replies.at(-1).text, /等待 runtime 调度器/);
  assert.equal(f.calls.some(c => c.name === 'task.run'), false);
});

test('uncertain completion retries identical immutable request, including after task became terminal', async t => {
  const f = fixture(t); let lost = true;
  const api = async (name, input) => {
    const result = await f.api(name, input);
    if (name === 'human_task.complete' && lost) { lost = false; throw new Error('response lost'); }
    return result;
  };
  let service = f.make({ api }); await service.handle(f.msg('/human')); await service.handle(f.msg('/human H1 填写'));
  await service.handle(f.msg('是')); await service.handle(f.msg('提交')); assert.equal(f.task.status, 'done');
  service = f.make({ api }); await service.handle(f.msg('重填')); assert.match(f.replies.at(-1).text, /相同请求重试/);
  await service.handle(f.msg('提交'));
  const submits = f.calls.filter(c => c.name === 'human_task.complete');
  assert.equal(submits.length, 2); assert.deepEqual(submits[0].input, submits[1].input);
});

test('files are copied only from newly received media into runtime inbox', async t => {
  const f = fixture(t, { requiredOutputs: [{ name: 'video', type: 'file', required: true, accept: ['.mp4'] }] });
  const service = f.make(); await service.handle(f.msg('/human')); await service.handle(f.msg('/human H1 填写'));
  const mediaPath = path.join(f.directory, 'clip.mp4'); fs.writeFileSync(mediaPath, 'video bytes');
  await service.handle(f.msg('/tmp/secret')); assert.match(f.replies.at(-1).text, /发送本字段的附件/);
  await service.handle(f.msg('', { mediaPath })); assert.match(f.replies.at(-1).text, /引用消息/);
  await service.handle(f.msg('', { mediaPath, raw: { item_list: [{ type: 5, video_item: { media: { full_url: 'https://example.invalid/test' } } }] } }));
  await service.handle(f.msg('提交'));
  const attachment = f.calls.find(c => c.name === 'human_task.complete').input.attachments[0];
  assert.equal(attachment.field, 'video'); assert.equal(path.dirname(attachment.path), path.join(f.directory, 'inbox'));
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'video bytes'); assert.equal(fs.existsSync(mediaPath), true);
});

test('rejection relays reason and cancelled task emits a stop notice, not a new assignment', async t => {
  const f = fixture(t), service = f.make(); await service.handle(f.msg('hello')); await service.tick();
  f.task.status = 'cancelled'; f.events.push({ taskId: ID, event: 'cancelled' }); await service.tick();
  assert.equal(f.sent.length, 2); assert.match(f.sent[1].text, /已取消/);
  await service.handle(f.msg('/human H1 填写')); assert.match(f.replies.at(-1).text, /工单已结束/);
});

test('reject request carries authenticated actor and supplied reason', async t => {
  const f = fixture(t), service = f.make(); await service.handle(f.msg('/human'));
  await service.handle(f.msg('/human H1 拒绝 不安全'));
  const call = f.calls.find(c => c.name === 'human_task.reject');
  assert.equal(call.input.actor, 'person-1'); assert.equal(call.input.reason, '不安全');
});

test('reconciliation paginates using runtime page.cursor and preserves global event cursor', async t => {
  const f = fixture(t), second = { ...f.task, taskId: 'ht-1111111111111111' };
  const api = async (name, input) => {
    if (name === 'human_task.list') return input.cursor === 0
      ? { data: { tasks: [f.task] }, page: { cursor: 100, truncated: true } }
      : { data: { tasks: [second] }, page: { cursor: null, truncated: false } };
    if (name === 'human_task.events') return { data: { events: [], nextCursor: 456 } };
    if (name === 'human_task.inspect' && input.task.taskId === second.taskId) return { data: { task: second } };
    return f.api(name, input);
  };
  const service = f.make({ api }); await service.tick();
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, 'human-tasks.json')));
  assert.equal(state.cursor, 456); assert.equal(Object.keys(state.tasks).length, 2);
});

test('route config rejects ambiguous mappings; primitive validation enforces required semantics', t => {
  const f = fixture(t), file = path.join(f.directory, 'routes.json');
  fs.writeFileSync(file, JSON.stringify({ routes: [f.route, f.route] }));
  assert.throws(() => loadHumanRoutes(file), /重复/);
  assert.equal(parseHumanValue({ type: 'bool' }, '否'), false);
  assert.throws(() => parseHumanValue({ type: 'number', min: 0, max: 100 }, '101'), /有效数字/);
  assert.throws(() => parseHumanValue({ type: 'enum', options: ['A', 'B'] }, 'C'), /请选择/);
});

test('consumer lock prevents concurrent notification services', async t => {
  const f = fixture(t), first = f.make(), second = f.make();
  first.start();
  try { assert.throws(() => second.start(), /已运行/); }
  finally { await first.close(); await second.close(); }
  assert.equal(fs.existsSync(path.join(f.directory, 'human-tasks.lock')), false);
});

test('a different human receipt never satisfies an uncertain submission', async t => {
  const f = fixture(t), service = f.make({ api: async (name, input) => {
    if (name === 'human_task.complete') {
      f.task.status = 'done';
      f.task.receipt = { attestation: 'human_relayed', outputs: input.outputs, rawText: input.rawText,
        completedBy: { actor: 'other-person', channel: 'weixin', messageId: input.messageId, relayedBy: input.relayedBy } };
      throw new Error('conflicting receipt');
    }
    return f.api(name, input);
  } });
  await service.handle(f.msg('/human')); await service.handle(f.msg('/human H1 填写'));
  await service.handle(f.msg('是')); await service.handle(f.msg('提交'));
  assert.match(f.replies.at(-1).text, /conflicting receipt/);
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, 'human-tasks.json')));
  assert.equal(Object.values(state.drafts)[0].submission.actor, 'person-1');
});

test('corrupt state fails closed instead of silently forgetting deliveries', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'human-tasks.json'), '{broken');
  assert.throws(() => f.make(), SyntaxError);
});


test('framed submission replay after restart returns the completed receipt', async t => {
  const f = fixture(t); let service = f.make();
  await service.handleInMode(f.msg('help'), '');
  await service.handleInMode(f.msg('H1 填写'), 'H1 填写');
  await service.handleInMode(f.msg('是'), '是');
  const message = f.msg('提交');
  await service.handleInMode(message, '提交');
  assert.equal(f.task.status, 'done');
  const completed = f.calls.filter(c => c.name === 'human_task.complete').length;
  service = f.make();
  await service.handleInMode(message, '提交');
  assert.equal(f.calls.filter(c => c.name === 'human_task.complete').length, completed);
  assert.doesNotMatch(f.replies.at(-1).text, /请先使用/);
});

test('human API uses the same local runtime root unless explicitly overridden', async () => {
  let executable;
  const api = createHumanTaskApi({ env: { META_AGENT_RUNTIME_DIR: '/local/runtime' }, run: async bin => {
    executable = bin; return { code: 0, stdout: '{"ok":true,"data":{}}' };
  } });
  await api('human_task.list', {});
  assert.equal(executable, '/local/runtime/dist/cli-glm.mjs');
});

test('human reentry chooses a saved task draft by ID instead of inheriting an active selection', async t => {
  const f = fixture(t), service = f.make();
  const turn = (body, modeSessionId) => service.handleInMode(f.msg(body, { modeSessionId }), body);
  await turn('help', 'first'); await turn('H1', 'first'); await turn('是', 'first');
  await turn('提交', 'second');
  assert.match(f.replies.at(-1).text, /选择/); assert.equal(f.task.status, 'pending');
  await turn('H1', 'second');
  assert.match(f.replies.at(-1).text, /已进入 H1/);
  await turn('提交', 'second'); assert.equal(f.task.status, 'done');
  const complete = f.calls.find(c => c.name === 'human_task.complete'); assert.equal(complete.input.outputs.safe, true);
});
