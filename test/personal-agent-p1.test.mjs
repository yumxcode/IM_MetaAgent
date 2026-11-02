import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalAgent, parseDecisionMessage } from '../src/personal-agent.mjs';
import { atomicWrite, identityOf, DurableStore } from '../src/durable-store.mjs';

const DAY = 24 * 60 * 60 * 1000;

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-p1-'));
  const sent = [], files = [], launches = [], alerts = [], calls = [];
  let seq = 0, time = Date.UTC(2026, 9, 28, 1, 0);
  const bot = {
    async sendText(msg) { sent.push(msg); return { messageId: msg.clientId }; },
    async sendFileAttachment(msg) { files.push({ kind: 'file', ...msg }); return {}; },
    async sendImageFile(msg) { files.push({ kind: 'image', ...msg }); return {}; },
  };
  const runtime = { list: [], inspect: {} };
  const options = { root, cfg: { allowFrom: ['u'], groupTrigger: 'off', maxConcurrent: 2, decisionPollMs: 60000, ...extra.cfg },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }), env: {} },
    bot, launcher: dir => { launches.push(dir); }, now: () => time, log: { warn() {}, info() {}, error() {} },
    alerts: { send(text, opts) { alerts.push({ text, opts }); return true; } },
    runtimeCall: async (capability, input) => { calls.push({ capability, input });
      if (capability === 'task.list') return { tasks: runtime.list, nextCursor: null };
      return runtime.inspect; },
    ...extra, cfg: undefined };
  options.cfg = { allowFrom: ['u'], groupTrigger: 'off', maxConcurrent: 2, decisionPollMs: 60000, ...extra.cfg };
  let app = new PersonalAgent(options);
  const msg = (commandText, overrides = {}) => ({ accountId: 'b', fromUserId: 'u', messageId: String(++seq), contextToken: 'token', commandText, text: commandText, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sent, files, launches, alerts, calls, runtime, msg, options,
    get app() { return app; }, advance(ms) { time += ms; }, get time() { return time; },
    async restart(cfg) { await app.close(); app = new PersonalAgent({ ...options, cfg: { ...options.cfg, ...cfg } }); return app; },
    request(index) { return JSON.parse(fs.readFileSync(path.join(launches[index], 'request.json'))); },
    finish(index, result = {}) { const request = this.request(index);
      atomicWrite(path.join(launches[index], 'result.json'), { ok: true, text: '完成结果', sessionId: `session-${index}`, requestId: request.id, ...result }); } };
}
const outboxTexts = app => Object.values(app.store.state.outbox).filter(o => o.kind !== 'file').map(o => o.text);

test('without WEIXIN_ALLOW_FROM the first private sender becomes the only owner', async t => {
  const f = fixture(t, { cfg: { allowFrom: [] } });
  f.app.accept(f.msg('/talk', { groupId: 'g1', fromUserId: 'group-member' }));
  assert.equal(f.app.store.state.owner, undefined);
  f.app.accept(f.msg('/talk'));
  assert.equal(f.app.store.state.owner.userId, 'u');
  assert.ok(outboxTexts(f.app).some(text => /唯一主人/.test(text)));
  const before = Object.keys(f.app.store.state.inbox).length;
  f.app.accept(f.msg('/auto', { fromUserId: 'stranger' })); f.app.accept(f.msg('rm -rf', { fromUserId: 'stranger' }));
  assert.equal(Object.keys(f.app.store.state.inbox).length, before);
  assert.ok(!Object.values(f.app.store.state.outbox).some(o => o.to === 'stranger'));
  assert.equal(f.alerts.filter(a => /stranger/.test(a.text)).length, 1);
  await f.restart();
  f.app.accept(f.msg('/auto', { fromUserId: 'stranger' }));
  assert.equal(f.app.store.state.owner.userId, 'u');
});

test('owner upgrade: one historic contact is adopted, several fail closed, * stays open', async t => {
  const f = fixture(t, { cfg: { allowFrom: [] } });
  await f.app.close();
  const seed = contacts => { const store = new DurableStore(f.root); store.update(state => { state.contacts = contacts; delete state.owner; delete state.ownerAmbiguous; }); store.close(); };
  seed({ [identityOf({ accountId: 'b', fromUserId: 'old' })]: { accountId: 'b', userId: 'old', token: 't' } });
  await f.restart({ allowFrom: [] });
  assert.equal(f.app.store.state.owner.via, 'migrated'); assert.equal(f.app.store.state.owner.userId, 'old');
  await f.app.close();
  seed({ [identityOf({ accountId: 'b', fromUserId: 'a' })]: { userId: 'a' }, [identityOf({ accountId: 'b', fromUserId: 'c' })]: { userId: 'c' } });
  await f.restart({ allowFrom: [] });
  assert.equal(f.app.store.state.owner, undefined); assert.equal(f.app.store.state.ownerAmbiguous, true);
  f.app.accept(f.msg('/talk', { fromUserId: 'a' }));
  assert.equal(Object.keys(f.app.store.state.inbox).length, 0);
  assert.ok(f.alerts.some(a => /多个历史私聊联系人/.test(a.text)));
  f.app.bindOwner('a', 'cli'); f.app.accept(f.msg('/talk', { fromUserId: 'a' }));
  assert.equal(Object.keys(f.app.store.state.inbox).length, 1);
  await f.restart({ allowFrom: ['*'] });
  f.app.accept(f.msg('/talk', { fromUserId: 'anyone' }));
  assert.equal(Object.keys(f.app.store.state.inbox).length, 2);
});

async function parkedTask(f) {
  f.app.accept(f.msg('/auto 部署新版本')); await f.app.tick();
  f.finish(0, { text: '[verify] 待决策' }); await f.app.tick();
  f.runtime.list = [{ target: { workspace: f.app.store.state.tasks.A1.workspace, sessionId: 'session-0' }, status: 'needs-decision', wakeId: 'w1' }];
  f.runtime.inspect = { task: { wake: { reason: '[待决策] 用哪个环境？', checkpoint: { needsHuman: { question: '部署到 staging 还是 prod？' } } } } };
}

test('needs-decision tasks are announced once and a quoted reply steers the task', async t => {
  const f = fixture(t);
  await parkedTask(f);
  await f.app.checkDecisions(); await f.app.checkDecisions();
  const notices = outboxTexts(f.app).filter(text => text.startsWith('【待决策 A1】'));
  assert.equal(notices.length, 1); assert.match(notices[0], /staging 还是 prod/);
  assert.equal(f.app.store.state.tasks.A1.status, 'needs-decision');
  // A quoted reply reaches the task wherever the conversation is.
  f.app.accept(f.msg('部署到 staging', { quoteContext: `[引用: ${notices[0]}]`, quotes: [{ body: notices[0] }] }));
  await f.app.tick();
  const request = f.request(1);
  assert.equal(request.intent, 'steer'); assert.equal(request.resumeSessionId, 'session-0'); assert.equal(request.prompt, '部署到 staging');
  assert.ok(f.app.store.state.tasks.A1.decision.answeredAt);
  // A new wake id (a second decision later) is announced again.
  f.finish(1, { sessionId: 'session-0' }); await f.app.tick();
  f.runtime.list[0].wakeId = 'w2'; await f.app.checkDecisions();
  assert.equal(outboxTexts(f.app).filter(text => text.startsWith('【待决策 A1】')).length, 2);
});

test('the explicit decision command works anywhere and unknown tasks are refused', async t => {
  const f = fixture(t);
  await parkedTask(f); await f.app.checkDecisions();
  assert.deepEqual(parseDecisionMessage({ commandText: '决定 a1 用 prod' }), { taskId: 'A1', prompt: '用 prod' });
  assert.equal(parseDecisionMessage({ commandText: '', quoteContext: '【待决策 A1】' }), null);
  f.app.accept(f.msg('决定 A1 用 prod')); await f.app.tick();
  assert.equal(f.request(1).prompt, '用 prod');
  f.app.accept(f.msg('决定 A9 任意')); await f.app.flushOutbox();
  assert.ok(f.sent.some(s => /没有找到你的任务 A9/.test(s.text)));
});

test('reminders proposed by chat are confirmed, fire durably and can be cancelled', async t => {
  const f = fixture(t);
  f.app.accept(f.msg('一小时后提醒我喝水，每天早上8点提醒我看日报')); await f.app.tick();
  const job = f.request(0); assert.deepEqual(job.schedules, []);
  f.finish(0, { text: '好的', scheduleOps: [
    { type: 'create', kind: 'remind', text: '喝水', at: f.time + 60 * 60 * 1000, nextAt: f.time + 60 * 60 * 1000 },
    { type: 'create', kind: 'remind', text: '看日报', cron: '0 8 * * *' },
    { type: 'create', kind: 'remind', text: '过期的', at: f.time - 1000 }] });
  await f.app.tick();
  const confirmation = outboxTexts(f.app).find(text => text.startsWith('好的'));
  assert.match(confirmation, /已创建 R1 · 提醒/); assert.match(confirmation, /已创建 R2 · 提醒 · 每天 08:00/); assert.match(confirmation, /提醒未生效/);
  f.advance(60 * 60 * 1000); await f.app.tick();
  const fired = Object.values(f.app.store.state.outbox).find(o => o.text.startsWith('【R1·提醒】喝水'));
  assert.ok(fired); assert.equal(fired.fallbackAlert, true);
  assert.equal(f.app.store.state.schedules.R1.enabled, false);
  await f.restart(); await f.app.tick();
  assert.equal(Object.values(f.app.store.state.outbox).filter(o => o.text.startsWith('【R1·提醒】喝水')).length, 1);
  assert.ok(f.app.store.state.notices[identityOf(f.msg(''))].some(n => n.refId === 'R1'), 'the fired reminder is remembered for the assistant');
  // Local commands in /tasks.
  f.app.accept(f.msg('/tasks 提醒')); await f.app.tick();
  assert.ok(outboxTexts(f.app).some(text => /^R2 · 提醒 · 每天 08:00/.test(text)));
  f.app.accept(f.msg('/tasks cancel R2')); await f.app.tick();
  assert.equal(f.app.store.state.schedules.R2.enabled, false);
});

test('scheduled prompts are handed to runtime and receipts are delivered exactly once locally', async t => {
  const f = fixture(t); const submitted = [], cancelled = [];
  const receipts = [{ id: 'run-1', status: 'succeeded', text: '今日要闻', completedAt: f.time }];
  f.app.adapter.schedules = async () => ({ submit(spec) { submitted.push(spec); }, cancel(id) { cancelled.push(id); }, receipts() { return receipts; }, ensureWorker() {} });
  f.app.store.update(state => {
    state.schedules.R1 = { id: 'R1', owner: identityOf(f.msg('')), origin: { accountId: 'b', fromUserId: 'u' }, kind: 'talk', text: '搜索新闻', cron: '*/30 * * * *', nextAt: f.time, enabled: true };
    state.contacts[identityOf(f.msg(''))] = { accountId: 'b', userId: 'u', token: 'token' };
  });
  await f.app.syncRuntimeSchedules(); await f.app.syncRuntimeSchedules();
  assert.equal(f.launches.length, 0);
  assert.equal(submitted.length, 1, 'submit is not repeated every sync');
  assert.equal(outboxTexts(f.app).filter(text => text.includes('今日要闻')).length, 1);
  f.app.store.update(state => { state.schedules.R1.enabled = false; });
  await f.app.syncRuntimeSchedules(); assert.equal(cancelled.length, 1);
  assert.equal(f.app.store.state.schedules.R1.runtimeCancelled, true);
  // A cancelled schedule leaves the sync: no client, no cancel, no receipts read.
  f.app.adapter.schedules = async () => { throw new Error('should not be called'); }; f.app.scheduleClient = null;
  await f.app.syncRuntimeSchedules(); assert.equal(cancelled.length, 1);
});

test('declared deliverables are snapshotted and sent as files after the text result', async t => {
  const f = fixture(t);
  f.app.accept(f.msg('/auto 生成周报')); await f.app.tick();
  const workspace = f.app.store.state.tasks.A1.workspace;
  fs.mkdirSync(workspace, { recursive: true });
  const report = path.join(workspace, 'report.pdf'), chart = path.join(workspace, 'chart.png'), big = path.join(workspace, 'big.zip');
  fs.writeFileSync(report, 'pdf'); fs.writeFileSync(chart, 'png'); fs.writeFileSync(big, Buffer.alloc(2048));
  await f.restart({ sendFileMaxBytes: 1024 });
  f.finish(0, { deliverables: { files: [report, chart, big], source: 'declared' } });
  await f.app.tick(); await f.app.flushOutbox();
  assert.match(f.sent[f.sent.length - 1].text, /交付文件 2 个/); assert.match(f.sent[f.sent.length - 1].text, /big\.zip/);
  assert.deepEqual(f.files.map(file => [file.kind, path.basename(file.filePath)]), [['file', '1-report.pdf'], ['image', '2-chart.png']]);
  assert.ok(f.files.every(file => file.filePath.startsWith(f.app.root) && file.contextToken === 'token'));
  fs.rmSync(report); // the snapshot, not the workspace file, is sent
  assert.ok(fs.existsSync(f.files[0].filePath));
});

test('pruning removes old finished records and their directories but keeps live work', async t => {
  const f = fixture(t, { cfg: { retentionDays: 30 } });
  f.app.accept(f.msg('/auto 旧任务')); await f.app.tick();
  f.finish(0); await f.app.tick(); await f.app.flushOutbox();
  f.app.accept(f.msg('/auto 新任务')); await f.app.tick();
  const oldExecution = Object.values(f.app.store.state.executions).find(e => e.status === 'succeeded');
  assert.ok(fs.existsSync(f.app.directory(oldExecution.id)));
  f.advance(31 * DAY);
  const dry = f.app.prune({ dryRun: true });
  assert.equal(dry.executions, 1); assert.ok(fs.existsSync(f.app.directory(oldExecution.id)));
  f.app.prune();
  const state = f.app.store.state;
  assert.equal(state.executions[oldExecution.id], undefined); assert.ok(!fs.existsSync(f.app.directory(oldExecution.id)));
  assert.ok(Object.values(state.executions).some(e => e.status === 'running'), 'running execution kept');
  assert.ok(state.inbox[Object.values(state.executions).find(e => e.status === 'running').inboxId], 'its inbox item kept');
  assert.equal(Object.values(state.outbox).filter(o => o.status === 'sent').length, 0);
  assert.equal(state.tasks.A1.goal, '旧任务', 'task records stay');
  assert.ok(state.lastPruneAt);
});

test('file snapshot integrity is checked before sending and a missing file fails permanently', async t => {
  const f=fixture(t),file=path.join(f.root,'snapshot.bin');fs.writeFileSync(file,Buffer.from([0xff]));
  const owner=identityOf(f.msg(''));
  f.app.store.update(state=>f.app.addFile(state,f.msg(''),{path:file,name:'snapshot.bin'},'integrity'));
  const entry=Object.values(f.app.store.state.outbox).find(e=>e.owner===owner&&e.kind==='file');
  fs.writeFileSync(file,Buffer.from([0xfe]));
  await assert.rejects(()=>f.app.sendEntry(entry,'token'),error=>error.permanent===true);
  fs.unlinkSync(file);
  await assert.rejects(()=>f.app.sendEntry(entry,'token'),error=>error.permanent===true);
});
