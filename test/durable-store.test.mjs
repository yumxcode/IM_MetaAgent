import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableStore, loadState } from '../src/durable-store.mjs';

function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const journalLines = root => fs.readFileSync(path.join(root, 'state.journal'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('an update appends only the records it changed and survives a crash through the journal', t => {
  const root = dir(t), store = new DurableStore(root, { verify: true });
  store.update(state => { for (let i = 0; i < 50; i++) state.inbox[`m${i}`] = { id: `m${i}`, status: 'done', text: 'x'.repeat(100) }; });
  const snapshotBefore = fs.statSync(path.join(root, 'state.json')).size;
  store.update(state => { state.inbox.m7.status = 'queued'; state.nextTask++; });
  const [, second] = journalLines(root);
  assert.deepEqual(second.o, [[null, 'nextTask', 2], ['inbox', 'm7', { id: 'm7', status: 'queued', text: 'x'.repeat(100) }]]);
  assert.equal(fs.statSync(path.join(root, 'state.json')).size, snapshotBefore, 'no snapshot rewrite per update');
  // Crash: no close(); a second instance must be able to start after the lock holder is gone.
  fs.unlinkSync(path.join(root, 'consumer.lock'));
  const reopened = new DurableStore(root);
  assert.equal(reopened.state.inbox.m7.status, 'queued'); assert.equal(reopened.state.nextTask, 2);
  assert.equal(fs.readFileSync(path.join(root, 'state.journal'), 'utf8'), '', 'replayed journal is folded into a new snapshot');
  reopened.close();
});

test('a throwing update leaves memory and disk exactly as before', t => {
  const root = dir(t), store = new DurableStore(root, { verify: true });
  store.update(state => { state.tasks.A1 = { id: 'A1', status: 'done', nested: { list: [1, 2] } }; });
  assert.throws(() => store.update(state => {
    state.tasks.A1.status = 'queued'; state.tasks.A1.nested.list.push(3); state.tasks.A2 = { id: 'A2' };
    delete state.inbox; state.nextTask = 9;
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(store.state.tasks, { A1: { id: 'A1', status: 'done', nested: { list: [1, 2] } } });
  assert.deepEqual(store.state.inbox, {}); assert.equal(store.state.nextTask, 1);
  assert.equal(journalLines(root).length, 1);
  store.close();
});

test('batch and lazy updates share commits; flush happens before close', async t => {
  const root = dir(t), store = new DurableStore(root, { verify: true, lazyMs: 20 });
  store.batch(() => {
    store.update(state => { state.inbox.a = { status: 'queued' }; });
    store.update(state => { state.executions.e = { status: 'running' }; });
  });
  assert.equal(journalLines(root).length, 1);
  store.update(state => { state.outbox.o = { status: 'sent' }; }, { lazy: true });
  assert.equal(journalLines(root).length, 1, 'lazy update is not written yet');
  store.update(state => { state.inbox.b = { status: 'queued' }; });
  assert.equal(journalLines(root).length, 2);
  assert.deepEqual(journalLines(root)[1].o.map(op => op.slice(0, 2)), [['outbox', 'o'], ['inbox', 'b']], 'the next commit carries the pending lazy write');
  store.update(state => { state.outbox.p = { status: 'sent' }; }, { lazy: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(journalLines(root).length, 3, 'lazy writes are committed within lazyMs');
  store.close();
  assert.equal(loadState(root).outbox.p.status, 'sent');
});

test('change listeners see every committed record; deletes report undefined', t => {
  const root = dir(t), store = new DurableStore(root), seen = [];
  store.onChange((collection, key, value) => seen.push([collection, key, value?.status]));
  store.update(state => { state.inbox.a = { status: 'queued' }; });
  store.update(state => { state.inbox.a.status = 'done'; delete state.inbox.a; state.lastPruneAt = 5; });
  assert.deepEqual(seen, [['inbox', 'a', 'queued'], ['inbox', 'a', undefined], [null, 'lastPruneAt', undefined]]);
  store.close();
});

test('a torn last journal line is ignored; a corrupt middle line fails closed', t => {
  const root = dir(t), store = new DurableStore(root);
  store.update(state => { state.inbox.a = { status: 'queued' }; });
  store.update(state => { state.inbox.b = { status: 'queued' }; });
  fs.closeSync(store.fd); store.fd = undefined; fs.unlinkSync(path.join(root, 'consumer.lock'));
  fs.appendFileSync(path.join(root, 'state.journal'), '{"o":[["inbox","c",{"sta');
  const reopened = new DurableStore(root);
  assert.deepEqual(Object.keys(reopened.state.inbox), ['a', 'b']);
  reopened.close();
  fs.writeFileSync(path.join(root, 'state.journal'), 'not json\n{"o":[]}\n');
  assert.throws(() => new DurableStore(root), /损坏/);
});

test('the snapshot is rewritten only when the journal outgrows its threshold', t => {
  const root = dir(t), store = new DurableStore(root, { compactBytes: 4096, compactLines: 10000 });
  for (let i = 0; i < 40; i++) store.update(state => { state.outbox[`o${i}`] = { text: 'y'.repeat(200) }; });
  assert.ok(store.stats.snapshots >= 2 && store.stats.snapshots <= 4, `snapshots: ${store.stats.snapshots}`);
  assert.ok(store.journalBytes < 4096 + 400);
  store.close();
  assert.equal(Object.keys(loadState(root).outbox).length, 40);
});

test('verify mode catches a write that bypassed the update view', t => {
  const root = dir(t), store = new DurableStore(root, { verify: true });
  store.update(state => { state.tasks.A1 = { status: 'done' }; });
  store.state.tasks.A1.status = 'sneaky';
  assert.throws(() => store.update(state => { state.nextTask++; }), /state\.tasks\.A1/);
  store.close();
});
