import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalAgent } from '../src/personal-agent.mjs';
import { atomicWrite, identityOf, digest, loadState } from '../src/durable-store.mjs';

const DAY = 24 * 60 * 60 * 1000;

function fixture(t, cfg = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-storage-'))) {
  const sent = [], launches = []; let seq = 0, time = Date.now();
  const options = { root, cfg: { allowFrom: ['u'], groupTrigger: 'off', maxConcurrent: 2, decisionPollMs: 0, statePollMs: 0, ...cfg },
    adapter: { settings: () => ({ bin: 'fake', profile: '/fake/config.json' }) },
    bot: { async sendText(msg) { sent.push(msg); return { messageId: msg.clientId }; } },
    launcher: dir => { launches.push(dir); }, now: () => time, log: { warn() {}, info() {}, error() {} } };
  const app = new PersonalAgent(options);
  const msg = (text, overrides = {}) => ({ accountId: 'b', fromUserId: 'u', messageId: String(++seq), contextToken: 'token', commandText: text, text, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, sent, launches, msg, advance(ms) { time += ms; }, get time() { return time; },
    finish(index, result = {}) { const dir = launches[index], request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json')));
      atomicWrite(path.join(dir, 'result.json'), { ok: true, text: '完成结果', sessionId: `session-${index}`, requestId: request.id, ...result }); } };
}
const backdate = (target, ms) => { const when = new Date(ms); fs.utimesSync(target, when, when); };
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

test('a chat message costs three journal appends and one coalesced delivery mark, never a snapshot rewrite', async t => {
  const f = fixture(t);
  await f.app.tick(); // startup work out of the way
  const { commits, snapshots } = f.app.store.stats;
  f.app.accept(f.msg('你好'));                 // 1: inbox record
  await f.app.tick();                          // 2: route + dispatch, before the worker starts
  assert.equal(f.launches.length, 1);
  f.finish(0); await f.app.tick();             // 3: result + reply
  await f.app.flushOutbox();                   // delivery mark is lazy
  assert.equal(f.sent.length, 1);
  assert.equal(f.app.store.stats.commits - commits, 3);
  f.app.store.flush();
  assert.equal(f.app.store.stats.commits - commits, 4);
  assert.equal(f.app.store.stats.snapshots, snapshots);
  // An idle pass writes nothing.
  await f.app.tick(); await f.app.flushOutbox(); f.app.store.flush();
  assert.equal(f.app.store.stats.commits - commits, 4);
});

test('stored records keep what is needed: no raw payload, no runtime copies, short delivered texts', async t => {
  const f = fixture(t);
  const raw = { item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p'.repeat(2000) } } }], extra: 'y'.repeat(4000) };
  const image = write(path.join(f.root, 'in.png'), 'png');
  f.app.accept(f.msg('看看这张图'.repeat(100), { raw, mediaItem: { type: 2 }, mediaPath: image, fileName: 'in.png', mediaType: 'image/png' }));
  const item = Object.values(f.app.store.state.inbox)[0];
  assert.equal(item.msg.raw, undefined); assert.equal(item.msg.mediaItem, undefined); assert.equal(item.msg.text, undefined);
  assert.equal(item.msg.freshMedia, true); assert.equal(item.msg.contextToken, undefined); assert.ok(item.msg.commandText.startsWith('看看这张图'));
  await f.app.tick();
  f.finish(0, { text: '回复'.repeat(3000) }); await f.app.tick(); await f.app.flushOutbox(); f.app.store.flush();
  const state = loadState(f.root);
  const e = Object.values(state.executions)[0];
  assert.equal(e.status, 'succeeded');
  for (const key of ['runtime', 'schedules', 'images']) assert.equal(e[key], undefined, key);
  assert.ok(e.prompt.length <= 121); assert.ok(e.result.text.length <= 101);
  const sent = Object.values(state.outbox).filter(o => o.status === 'sent');
  assert.ok(sent.length >= 2, 'long reply was chunked and sent');
  assert.ok(sent.every(o => o.text === undefined && o.sentAt), 'delivered chat replies keep no text');
  assert.ok(f.sent.map(s => s.text).join('').includes('回复'.repeat(1000)), 'the full reply was delivered');
});

test('records written by 1.5.0 shrink once on upgrade', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-storage-'));
  const owner = identityOf({ accountId: 'b', fromUserId: 'u' });
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 1, nextTask: 1, contacts: {}, conversations: {}, tasks: {}, pendingMedia: {}, projects: {}, selectedProjects: {},
    inbox: { i1: { id: 'i1', owner, status: 'done', createdAt: 1, msg: { accountId: 'b', fromUserId: 'u', messageId: '1', commandText: 'hi', text: 'hi', raw: { big: 'z'.repeat(5000) } } } },
    executions: { e1: { id: 'e1', inboxId: 'i1', owner, status: 'succeeded', prompt: 'p'.repeat(5000), runtime: { bin: 'x' }, schedules: [{ id: 'R1' }], result: { ok: true, text: 'r'.repeat(5000) } } },
    outbox: { o1: { id: 'o1', owner, status: 'sent', text: 'hello', receipt: { messageId: 'm' } }, o2: { id: 'o2', owner, status: 'sent', text: 't'.repeat(2000), ref: { kind: 'task_result', refId: 'A1' } } } }));
  const f = fixture(t, {}, root);
  const state = f.app.store.state;
  assert.equal(state.storeVersion, 2);
  assert.deepEqual(state.inbox.i1.msg, { accountId: 'b', fromUserId: 'u', messageId: '1', commandText: 'hi', inboxId: 'i1' });
  assert.equal(state.executions.e1.runtime, undefined); assert.equal(state.executions.e1.schedules, undefined);
  assert.ok(state.executions.e1.prompt.length <= 121); assert.ok(state.executions.e1.result.text.length <= 101);
  assert.equal(state.outbox.o1.text, undefined); assert.equal(state.outbox.o1.receipt, undefined);
  assert.ok(state.outbox.o2.text.length <= 601, 'quoted-reply matching keeps the start of ref messages');
});

test('retention clears old chat files and scheduled runs; isolated task folders only with the switch', async t => {
  const f = fixture(t, { retentionDays: 7 });
  const owner = identityOf(f.msg('')), old = f.time - 10 * DAY;
  f.app.store.update(state => {
    state.conversations[owner] = { id: 'c1' };
    state.tasks.A1 = { id: 'A1', owner, workspace: path.join(f.root, 'workspaces', digest(owner).slice(0, 24), 'A1'), sessionId: 's1', status: 'succeeded', runtimeState: { status: 'finished' }, lastActivityAt: old, createdAt: old };
    state.tasks.A2 = { id: 'A2', owner, workspace: path.join(f.root, 'mine'), sessionId: 's2', status: 'succeeded', runtimeState: { status: 'finished' }, lastActivityAt: old, createdAt: old };
    state.notices[owner] = [{ at: old, text: 'old' }, { at: f.time, text: 'new' }];
  });
  const talk = path.join(f.root, 'talk', digest(owner).slice(0, 24), 'c1');
  const oldInput = path.dirname(write(path.join(talk, 'im-inputs', 'old-item', 'a.pdf'))), newInput = path.dirname(write(path.join(talk, 'im-inputs', 'new-item', 'b.pdf')));
  const oldOut = write(path.join(talk, 'outbox', 'old.txt')), newOut = write(path.join(talk, 'outbox', 'new.txt'));
  const memory = write(path.join(talk, 'notes.md'));
  const runs = path.join(f.root, 'scheduled-work', digest(owner), 'R1');
  const oldRun = path.dirname(write(path.join(runs, '1700000000000', 'r.md'))), newRun = path.dirname(write(path.join(runs, String(f.time), 'r.md')));
  const oldSnapshot = path.dirname(write(path.join(f.root, 'outbox-files', 'receipt-digest', '1-r.md')));
  const workspaceFile = write(path.join(f.app.store.state.tasks.A1.workspace, 'report.md'));
  const userFile = write(path.join(f.root, 'mine', 'keep.md'));
  for (const target of [oldInput, oldOut, oldRun, oldSnapshot, memory]) backdate(target, old);

  f.app.prune();
  for (const gone of [oldInput, oldOut, oldRun, oldSnapshot]) assert.ok(!fs.existsSync(gone), gone);
  for (const kept of [newInput, newOut, newRun, memory, workspaceFile, userFile]) assert.ok(fs.existsSync(kept), kept);
  assert.deepEqual(f.app.store.state.notices[owner].map(n => n.text), ['new']);
  assert.equal(f.app.store.state.tasks.A1.workspaceRemoved, undefined);

  f.app.cfg.pruneTaskWorkspaces = true;
  f.app.prune();
  assert.ok(!fs.existsSync(workspaceFile)); assert.ok(f.app.store.state.tasks.A1.workspaceRemoved);
  assert.ok(fs.existsSync(userFile), 'a folder outside the IM workspace root is never removed');
  assert.equal(f.app.store.state.tasks.A2.workspaceRemoved, undefined);
  assert.equal(f.app.store.state.tasks.A1.goal, undefined); assert.ok(f.app.store.state.tasks.A1, 'the task record itself stays');
  // A removed workspace cannot be resumed.
  assert.throws(() => f.app.store.update(state => f.app.runTask(state, { id: 'x', owner }, state.tasks.A1, { intent: 'continue', prompt: 'go' })), /已按保留策略清理/);
  // Removed entries were folded into a fresh snapshot.
  assert.equal(fs.readFileSync(path.join(f.root, 'state.journal'), 'utf8'), '');
});
