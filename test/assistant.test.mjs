import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PersonalAgent, proposalOp, REF_TAG } from '../src/personal-agent.mjs';
import { atomicWrite, identityOf } from '../src/durable-store.mjs';
import { TalkHost, probeServe } from '../src/talk-host.mjs';
import { parseRoots, resolveInRoots, planCreate, WorkspaceCatalog, searchTokens, gitInfo } from '../src/workspaces.mjs';
import { parseAt, planSchedule } from '../src/schedules.mjs';
import { ASSISTANT_TOOL_SPECS } from '../src/assistant-tools.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

/** A user folder tree: two projects inside the roots, one folder outside, one symlink escaping. */
function folders(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'im-roots-')));
  const roots = path.join(base, 'code'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(roots, 'wechat-bot', '.git'), { recursive: true }); fs.mkdirSync(path.join(roots, 'notes')); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(roots, 'wechat-bot', 'README.md'), '# 微信个人智能体\n以 meta-agent 为执行底座的微信机器人。');
  fs.writeFileSync(path.join(roots, 'wechat-bot', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(roots, 'wechat-bot', '.git', 'config'), '[remote "origin"]\n\turl = https://user:secret-token@example.com/me/wechat-bot.git\n');
  fs.writeFileSync(path.join(roots, 'notes', 'README.md'), '读书笔记与周报');
  fs.symlinkSync(outside, path.join(roots, 'escape'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, roots, outside };
}

class FakeHost {
  constructor() { this.available = true; this.turns = []; this.next = null; }
  turn(request) {
    if (this.next) { const answer = this.next; this.next = null; return Promise.resolve({ id: request.id, ...answer }); }
    return new Promise(resolve => this.turns.push({ request, resolve }));
  }
}

function fixture(t, { cfg = {}, roots = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-assistant-'));
  const sent = [], files = [], launches = [], typing = [];
  let seq = 0, time = Date.UTC(2026, 9, 28, 1, 0);
  const bot = {
    async sendText(msg) { sent.push(msg); return { messageId: msg.clientId }; },
    async sendFileAttachment(msg) { files.push(msg); return {}; },
    async typing() { return { async start() { typing.push('start'); }, async stop() { typing.push('stop'); } }; },
  };
  const options = { root, bot, launcher: dir => { launches.push(dir); }, now: () => time, log: { warn() {}, info() {}, error() {} },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }), env: {} },
    cfg: { allowFrom: ['u', 'u2'], groupTrigger: 'off', maxConcurrent: 1, decisionPollMs: 0, statePollMs: 0, slowNoticeMs: 0, workspaceRoots: roots, ...cfg } };
  let app = new PersonalAgent(options), host = new FakeHost(); app.setTalkHost(host);
  const msg = (commandText, overrides = {}) => ({ accountId: 'b', fromUserId: 'u', messageId: String(++seq), contextToken: 'token', commandText, text: commandText, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const f = { root, sent, files, launches, typing, msg, options, get app() { return app; }, get host() { return host; },
    advance(ms) { time += ms; }, get time() { return time; },
    async restart() { await app.close(); app = new PersonalAgent(options); host = new FakeHost(); app.setTalkHost(host); return app; },
    /** Accept a chat message and run until the assistant has it. Returns the pending turn. */
    async say(text, overrides) { app.accept(msg(text, overrides)); await app.tick(); await flush(); return host.turns.at(-1); },
    tool(turn, name, input = {}) { return app.tools.call(name, input, { turnId: turn.request.id }); },
    async answer(turn, result = {}) { turn.resolve({ ok: true, subtype: 'success', text: '好的', sessionId: 'chat-session', ...result }); await flush(); await flush(); },
    texts() { return Object.values(app.store.state.outbox).filter(o => o.kind !== 'file').map(o => o.text); },
    owner: identityOf({ accountId: 'b', fromUserId: 'u' }) };
  return f;
}

test('chat turns run on the resident assistant, show typing, resume the session and deliver outbox files', async t => {
  const f = fixture(t);
  const turn = await f.say('你好');
  assert.equal(f.launches.length, 0, 'no worker process for a chat turn');
  const execution = f.app.store.state.executions[turn.request.id];
  assert.equal(execution.transport, 'serve'); assert.equal(turn.request.sessionId, undefined);
  assert.match(turn.request.prompt, /^\[当前时间：2026-10-28 .*\]\n你好$/);
  fs.mkdirSync(path.join(turn.request.workspace, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(turn.request.workspace, 'outbox', 'summary.txt'), '摘要');
  await f.answer(turn, { text: '你好呀', costUsd: 0.01, timing: { firstEventMs: 5, totalMs: 9 }, result: { artifacts: [] } });
  const done = f.app.store.state.executions[turn.request.id];
  assert.equal(done.status, 'succeeded'); assert.equal(done.timing.firstEventMs, 5);
  assert.ok(f.texts().some(text => text.startsWith('你好呀') && /交付文件 1 个/.test(text)));
  assert.deepEqual(f.typing, ['start', 'stop']);
  await f.app.flushOutbox(); assert.equal(path.basename(f.files[0].filePath), '1-summary.txt');
  const second = await f.say('继续');
  assert.equal(second.request.sessionId, 'chat-session'); assert.equal(second.request.workspace, turn.request.workspace);
});

test('/auto 目标 asks the assistant to settle the folder and propose; it never starts work by itself', async t => {
  const f = fixture(t);
  const turn = await f.say('/auto 修复登录失败的问题');
  assert.match(turn.request.prompt, /task_propose[\s\S]*修复登录失败的问题/);
  await f.answer(turn);
  assert.equal(Object.keys(f.app.store.state.tasks).length, 0); assert.equal(f.launches.length, 0);
});

test('a proposal starts work only after the user confirms, in the confirmed folder', async t => {
  const dirs = folders(t), f = fixture(t, { roots: [dirs.roots] });
  const turn = await f.say('帮我修一下微信机器人项目的登录');
  const search = JSON.parse((await f.tool(turn, 'workspace_search', { query: '微信机器人' })).content);
  assert.equal(search.results[0].name, 'wechat-bot');
  assert.doesNotMatch(JSON.stringify(search), /secret-token/, 'credentials in remotes are never shown');
  const proposed = await f.tool(turn, 'task_propose', { goal: '修复登录', workspace: path.join(dirs.roots, 'wechat-bot'), alternatives: [path.join(dirs.roots, 'notes')], reason: 'README 写的是微信机器人' });
  assert.equal(proposed.isError, false); assert.match(proposed.content, /P1/);
  await f.answer(turn, { text: '我已发出确认，回复“确认”即可开始。' });
  const card = f.texts().find(text => text.startsWith('【P1·确认】'));
  assert.match(card, /目标：修复登录/); assert.match(card, /wechat-bot（git main/); assert.match(card, /2\. .*notes/);
  assert.equal(Object.keys(f.app.store.state.tasks).length, 0, 'nothing runs before the user answers');
  f.app.accept(f.msg('确认')); await f.app.tick();
  const task = f.app.store.state.tasks.A1;
  assert.equal(task.workspace, path.join(dirs.roots, 'wechat-bot')); assert.equal(task.goal, '修复登录');
  assert.equal(f.launches.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(f.launches[0], 'request.json'))).workspace, task.workspace);
  assert.ok(f.texts().some(text => text.startsWith('【A1·已开始】修复登录')));
  assert.equal(f.app.store.state.lastWorkspace[f.owner], task.workspace);
  f.app.accept(f.msg('确认')); await f.app.tick(); await f.app.tick();
  assert.equal(Object.keys(f.app.store.state.tasks).length, 1, 'a repeated confirmation does not start a second task');
});

test('proposals: choose an alternative, create a folder on confirm, cancel, supersede and expire', async t => {
  const dirs = folders(t), f = fixture(t, { roots: [dirs.roots] });
  let turn = await f.say('整理笔记');
  await f.tool(turn, 'task_propose', { goal: '整理笔记', workspace: path.join(dirs.roots, 'wechat-bot'), alternatives: [path.join(dirs.roots, 'notes')] });
  await f.answer(turn);
  f.app.accept(f.msg('2')); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A1.workspace, path.join(dirs.roots, 'notes'));

  turn = await f.say('新开一个项目');
  await f.tool(turn, 'task_propose', { goal: '搭建新项目', create: { parent: dirs.roots, name: 'new-proj' } });
  await f.answer(turn);
  assert.equal(fs.existsSync(path.join(dirs.roots, 'new-proj')), false, 'created only after confirmation');
  f.app.accept(f.msg('好')); await f.app.tick();
  assert.equal(f.app.store.state.tasks.A2.workspace, path.join(dirs.roots, 'new-proj'));
  assert.ok(fs.statSync(path.join(dirs.roots, 'new-proj')).isDirectory());

  turn = await f.say('两个方案');
  await f.tool(turn, 'task_propose', { goal: '方案一' }); await f.tool(turn, 'task_propose', { goal: '方案二' });
  await f.answer(turn);
  const proposals = f.app.store.state.proposals;
  assert.equal(proposals.P3.status, 'superseded'); assert.equal(proposals.P4.status, 'pending');
  f.app.accept(f.msg('取消')); await f.app.tick();
  assert.equal(f.app.store.state.proposals.P4.status, 'cancelled');

  turn = await f.say('明天再说');
  await f.tool(turn, 'task_propose', { goal: '过期的提议' }); await f.answer(turn);
  f.advance(25 * 60 * 60 * 1000);
  f.app.accept(f.msg('确认')); await f.app.tick();
  assert.equal(Object.keys(f.app.store.state.tasks).length, 2, 'an expired proposal never starts work');
  assert.equal(Object.values(f.app.store.state.executions).at(-1).kind, 'talk', 'with nothing pending, "确认" is just chat');
  const quotedExpired = f.msg('确认', { quoteContext: '[引用: 【P5·确认】准备启动工作任务]' });
  f.app.accept(quotedExpired); await f.app.tick();
  assert.ok(f.texts().some(text => /P5 已过期/.test(text)));
  assert.equal(Object.keys(f.app.store.state.tasks).length, 2);
  assert.deepEqual([proposalOp('确认'), proposalOp('2号'), proposalOp('算了'), proposalOp('确认一下目录对不对')], [{ op: 'confirm' }, { op: 'choose', choice: 2 }, { op: 'cancel' }, null]);
});

test('folder tools stay inside IM_WORKSPACE_ROOTS and refuse symlink escapes', async t => {
  const dirs = folders(t), f = fixture(t, { roots: [dirs.roots] });
  const turn = await f.say('看看我的项目');
  const listed = JSON.parse((await f.tool(turn, 'workspace_list')).content);
  assert.deepEqual(listed.roots[0].folders, ['notes', 'wechat-bot'], 'symlinked folders are not offered');
  const peek = JSON.parse((await f.tool(turn, 'workspace_peek', { path: path.join(dirs.roots, 'wechat-bot') })).content);
  assert.match(peek.readme, /微信个人智能体/); assert.equal(peek.git.branch, 'main');
  for (const bad of [dirs.outside, path.join(dirs.roots, 'escape'), path.join(dirs.roots, '..'), 'relative/path']) {
    const result = await f.tool(turn, 'workspace_peek', { path: bad });
    assert.equal(result.isError, true, bad);
  }
  const refused = await f.tool(turn, 'task_propose', { goal: 'x', workspace: path.join(dirs.roots, 'escape') });
  assert.equal(refused.isError, true); assert.match(refused.content, /不在允许的范围/);
  assert.equal((await f.tool(turn, 'task_propose', { goal: 'x', create: { parent: dirs.roots, name: '../up' } })).isError, true);
  await f.answer(turn);
  assert.ok(!f.texts().some(text => /【P\d+·确认】/.test(text)), 'no card for a refused proposal');
  assert.equal((await f.tool(turn, 'workspace_list')).isError, true, 'tools only work during their own turn');
  const none = fixture(t);
  const noRoots = await none.say('找项目');
  assert.match((await none.tool(noRoots, 'workspace_search', { query: 'x' })).content, /未配置 IM_WORKSPACE_ROOTS/);
  await none.answer(noRoots);
});

test('quoted notices route back to their task, and notices reach the assistant once', async t => {
  const f = fixture(t);
  f.app.store.update(state => {
    state.tasks.A1 = { id: 'A1', owner: f.owner, goal: '生成周报', workspace: f.root, sessionId: 's', status: 'succeeded', mode: 'auto', result: { ok: true, text: '周报已生成' } };
    state.schedules.R1 = { id: 'R1', owner: f.owner, origin: { accountId: 'b', fromUserId: 'u' }, kind: 'remind', text: '交周报', at: f.time, nextAt: f.time, enabled: true };
    f.app.addReply(state, f.msg(''), '【A1·结果】本次执行已返回\n周报已生成，共 3 页', 'result-a1', { ref: { kind: 'task_result', refId: 'A1' }, notice: true });
  });
  await f.app.tick();
  const first = await f.say('刚才的提醒推迟一小时');
  assert.match(first.request.prompt, /\[期间发给用户的通知，供参考\][\s\S]*【A1·结果】[\s\S]*【R1·提醒】交周报[\s\S]*\[用户消息\]\n刚才的提醒推迟一小时/);
  await f.answer(first);
  const second = await f.say('谢谢');
  assert.doesNotMatch(second.request.prompt, /期间发给用户的通知/);
  await f.answer(second);
  const quoted = await f.say('第二页再展开一下', { quoteContext: '[引用: 【A1·结果】本次执行已返回]' });
  assert.match(quoted.request.prompt, /\[用户引用的任务\]\nA1 · [\s\S]*生成周报/);
  await f.answer(quoted);
  const byText = await f.say('这个结果对吗', { quoteContext: '[引用: 周报已生成，共 3 页]', quotes: [{ body: '周报已生成，共 3 页' }] });
  assert.match(byText.request.prompt, /\[用户引用的任务\]\nA1/, 'a quote without the tag is matched by its text');
  await f.answer(byText);
  assert.equal(REF_TAG.exec('【待决策 A12】')[1], 'A12'); assert.equal(REF_TAG.exec('【R3·定时】')[1], 'R3');
});

test('task tools only touch the owner\'s tasks and IM echoes what they did', async t => {
  const f = fixture(t, { cfg: { maxConcurrent: 2 } });
  f.app.store.update(state => {
    state.tasks.A1 = { id: 'A1', owner: f.owner, goal: '写文档', workspace: f.root, sessionId: 's1', status: 'succeeded', mode: 'auto', runtime: { bin: 'fake' } };
    state.tasks.A2 = { id: 'A2', owner: identityOf({ accountId: 'b', fromUserId: 'u2' }), goal: '别人的', workspace: f.root, sessionId: 's2', status: 'succeeded', mode: 'auto', runtime: {} };
  });
  const turn = await f.say('给 A1 加一章');
  assert.match((await f.tool(turn, 'task_status')).content, /A1 · succeeded · 写文档/);
  assert.doesNotMatch((await f.tool(turn, 'task_status')).content, /别人的/);
  assert.equal((await f.tool(turn, 'task_steer', { task: 'A2', text: '删除' })).isError, true);
  assert.equal((await f.tool(turn, 'task_decide', { task: 'A1', answer: '用 prod' })).isError, true, 'no pending decision');
  const steered = await f.tool(turn, 'task_steer', { task: 'a1', text: '加一章 FAQ' });
  assert.equal(steered.isError, false);
  const steer = Object.values(f.app.store.state.executions).find(e => e.kind === 'auto');
  assert.equal(steer.intent, 'steer'); assert.equal(steer.resumeSessionId, 's1'); assert.equal(steer.prompt, '加一章 FAQ');
  assert.ok(f.texts().some(text => text === '【A1·补充】已交给 A1：加一章 FAQ'));
  assert.equal((await f.tool(turn, 'task_steer', { task: 'A1', text: '再加' })).isError, true, 'busy tasks refuse more steering');
  assert.match((await f.tool(turn, 'task_cancel', { task: 'A1' })).content, /已取消 A1 尚未启动的一轮/);
  f.app.store.update(state => { state.tasks.A1.status = 'needs-decision'; state.tasks.A1.decision = { wakeId: 'w9', question: '哪个环境？' }; });
  assert.equal((await f.tool(turn, 'task_decide', { task: 'A1', answer: 'staging' })).isError, false);
  const decision = Object.values(f.app.store.state.executions).filter(e => e.kind === 'auto').at(-1);
  assert.equal(decision.expectedWakeId, 'w9'); assert.equal(decision.prompt, 'staging');
  await f.answer(turn);
});

test('reminders created by the assistant use the owner\'s time zone and are confirmed in the reply', async t => {
  const f = fixture(t);
  f.app.store.update(state => { state.notificationPreferences[f.owner] = { timeZone: 'Asia/Shanghai' }; });
  const turn = await f.say('今天下午三点提醒我开会');
  assert.match(turn.request.prompt, /\[当前时间：2026-10-28 周三 09:00（Asia\/Shanghai）\]/);
  const created = await f.tool(turn, 'reminder_create', { text: '开会', at: '2026-10-28 15:00' });
  assert.equal(created.isError, false, created.content);
  assert.equal(f.app.store.state.schedules.R1.at, Date.UTC(2026, 9, 28, 7, 0));
  assert.match((await f.tool(turn, 'reminder_list')).content, /R1/);
  assert.equal((await f.tool(turn, 'reminder_create', { text: '过去', at: '2026-10-28 08:00' })).isError, true);
  await f.answer(turn, { text: '好的，下午三点提醒你。' });
  assert.ok(f.texts().some(text => text.startsWith('好的，下午三点提醒你。') && /已创建 R1/.test(text)));
});

test('an interrupted resident turn is reported, never replayed; an unavailable assistant falls back to one-shot runs', async t => {
  const f = fixture(t);
  await f.say('一个很长的问题');
  await f.restart(); await f.app.tick();
  const [interrupted] = Object.values(f.app.store.state.executions);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.result.subtype, 'interrupted');
  assert.ok(f.texts().some(text => /重启了，请再发一次/.test(text)));
  assert.equal(f.host.turns.length, 0);
  f.host.next = { ok: false, subtype: 'serve_unavailable', error: { message: 'down' } };
  f.app.accept(f.msg('还在吗')); await f.app.tick(); await flush(); await flush();
  const queued = Object.values(f.app.store.state.executions).at(-1);
  assert.equal(queued.status, 'queued'); assert.equal(queued.forceCli, true);
  await f.app.tick();
  assert.equal(f.launches.length, 1, 'the same turn now runs as a one-shot CLI');
});

test('human_open hands the form to the work-order service', async t => {
  const f = fixture(t), opened = [];
  f.app.setHumanTasks({ observe() {}, isFilling: () => false, async handleInMode(msg, body) { opened.push(body); } });
  const turn = await f.say('我要填 H1');
  assert.equal((await f.tool(turn, 'human_open', { ticket: 'H1' })).isError, false);
  assert.equal((await f.tool(turn, 'human_open', { ticket: '; rm' })).isError, true);
  assert.deepEqual(opened, ['H1 填写']);
  await f.answer(turn);
  assert.ok(ASSISTANT_TOOL_SPECS.every(spec => /^[a-z][a-z0-9_]{1,63}$/.test(spec.name) && spec.inputSchema.type === 'object'));
});

// ── TalkHost against a scripted serve process ───────────────────────────────

const FAKE_SERVE = `
const readline = require('node:readline');
if (process.argv.includes('--help')) { console.log('Usage: meta-agent serve [options]'); process.exit(0); }
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
out({ type: 'ready', protocol: 1, version: '0.14.0', pid: process.pid });
const waiting = new Map();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'ping') out({ type: 'pong', id: m.id });
  if (m.type === 'shutdown') { out({ type: 'bye' }); process.exit(0); }
  if (m.type === 'tool_result') { const id = waiting.get(m.callId); out({ type: 'turn_end', id, ok: true, subtype: 'success', sessionId: 's', text: 'tool said ' + m.content }); }
  if (m.type === 'turn') {
    out({ type: 'accepted', id: m.id, position: 0 });
    if (m.prompt === 'crash') process.exit(3);
    if (m.prompt === 'tool') { waiting.set('c1', m.id); out({ type: 'tool_call', id: m.id, callId: 'c1', name: 'workspace_list', input: { path: '~' } }); return; }
    out({ type: 'turn_end', id: m.id, ok: true, subtype: 'success', sessionId: 's', text: 'echo ' + m.prompt });
  }
});`;

function serveScript(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-serve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'serve.cjs'); fs.writeFileSync(file, FAKE_SERVE);
  return (bin, argv, opts) => spawn(process.execPath, [file, ...argv], opts);
}

test('TalkHost runs turns, answers tool calls, and restarts a crashed process', async t => {
  const spawnImpl = serveScript(t), tools = [];
  assert.equal(await probeServe('meta-agent', { spawnImpl }), true);
  const host = new TalkHost({ bin: 'meta-agent', spawnImpl, log: { info() {}, warn() {}, error() {} }, pingIntervalMs: 60000,
    onToolCall: async (name, input, meta) => { tools.push({ name, input, turnId: meta.turnId }); return { content: 'ok-folders', isError: false }; } });
  t.after(() => host.close());
  await host.start();
  const echo = await host.turn({ id: 't1', workspace: '/tmp', prompt: 'hi' });
  assert.equal(echo.ok, true); assert.equal(echo.text, 'echo hi'); assert.ok(echo.timing.totalMs >= 0);
  const tool = await host.turn({ id: 't2', workspace: '/tmp', prompt: 'tool' });
  assert.equal(tool.text, 'tool said ok-folders'); assert.deepEqual(tools, [{ name: 'workspace_list', input: { path: '~' }, turnId: 't2' }]);
  const crashed = await host.turn({ id: 't3', workspace: '/tmp', prompt: 'crash' });
  assert.equal(crashed.ok, false); assert.equal(crashed.subtype, 'serve_crashed');
  const after = await host.turn({ id: 't4', workspace: '/tmp', prompt: 'again' });
  assert.equal(after.text, 'echo again', 'the next turn restarts the process');
  assert.equal(host.available, true);
});

test('TalkHost disables itself after repeated crashes; probe rejects older runtimes', async t => {
  const spawnImpl = serveScript(t);
  const host = new TalkHost({ bin: 'meta-agent', spawnImpl, maxRestarts: 1, log: { info() {}, warn() {}, error() {} }, pingIntervalMs: 60000, onToolCall: async () => ({ content: '' }) });
  t.after(() => host.close());
  await host.turn({ id: 'a', workspace: '/tmp', prompt: 'crash' });
  await host.turn({ id: 'b', workspace: '/tmp', prompt: 'crash' });
  assert.equal(host.available, false);
  const refused = await host.turn({ id: 'c', workspace: '/tmp', prompt: 'hi' });
  assert.equal(refused.subtype, 'serve_unavailable');
  const old = (bin, argv, opts) => spawn(process.execPath, ['-e', 'console.log("meta-agent v0.13.6 usage: meta-agent [prompt]")'], opts);
  assert.equal(await probeServe('meta-agent', { spawnImpl: old }), false);
});

// ── Folders and time zones ──────────────────────────────────────────────────

test('workspace roots reject the home folder, root and missing paths; search ranks by meaning-bearing text', async t => {
  const dirs = folders(t);
  const parsed = parseRoots(`${dirs.roots},~,/,${path.join(dirs.base, 'missing')}`);
  assert.deepEqual(parsed.roots, [dirs.roots]); assert.equal(parsed.problems.length, 3);
  assert.throws(() => resolveInRoots([dirs.roots], dirs.roots), /不在允许的范围/, 'a root itself is not a task folder');
  assert.equal(resolveInRoots([dirs.roots], dirs.roots, { allowRoot: true }).real, dirs.roots);
  assert.throws(() => planCreate([dirs.roots], dirs.roots, 'notes'), /已存在/);
  assert.throws(() => planCreate([dirs.roots], dirs.roots, '.hidden'), /文件夹名/);
  assert.equal(planCreate([dirs.roots], dirs.roots, '新项目'), path.join(dirs.roots, '新项目'));
  const catalog = new WorkspaceCatalog([dirs.roots]);
  assert.equal(catalog.search('那个微信机器人')[0].name, 'wechat-bot');
  assert.equal(catalog.search('周报')[0].name, 'notes');
  assert.ok(catalog.search('').length >= 2);
  assert.ok(searchTokens('微信机器人').includes('机器'));
  assert.equal(gitInfo(path.join(dirs.roots, 'wechat-bot')).remote, 'https://example.com/me/wechat-bot.git');
});

test('wall-clock reminder times are read in the owner\'s time zone', () => {
  const now = Date.UTC(2026, 9, 28, 1, 0); // 09:00 in Shanghai
  assert.equal(parseAt('2026-10-28 15:00', now, { timeZone: 'Asia/Shanghai' }), Date.UTC(2026, 9, 28, 7, 0));
  assert.equal(parseAt('08:30', now, { timeZone: 'Asia/Shanghai' }), Date.UTC(2026, 9, 29, 0, 30), 'a time already past today means tomorrow');
  assert.equal(parseAt('2026-11-02 09:00', now, { timeZone: 'America/New_York' }), Date.UTC(2026, 10, 2, 14, 0));
  assert.throws(() => parseAt('2026-02-30 09:00', now, { timeZone: 'Asia/Shanghai' }), /无效时间/);
  assert.equal(planSchedule({ text: '开会', at: '2026-10-28 15:00' }, now, { timeZone: 'Asia/Shanghai' }).at, Date.UTC(2026, 9, 28, 7, 0));
});
