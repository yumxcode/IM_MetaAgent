import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyProgress } from '../src/reply-progress.mjs';

const msg = { accountId: 'bot-A', fromUserId: 'user-A', contextToken: 'context-A', runId: 'run-A' };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('actual runtime id/name events map to matching progress and omit tool input/output', async () => {
  const calls = [];
  const progress = createReplyProgress({ sendToolProgress: async args => calls.push(args) }, msg);
  progress.onEvent({ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { secret: 'private-input' } });
  progress.onEvent({ type: 'tool_result', id: 'toolu_01', toolName: 'wrong-name', content: 'private-output', isError: false });
  progress.onEvent({ type: 'tool_use', toolUseId: 'toolu_02', toolName: 'bash' });
  progress.onEvent({ type: 'tool_result', tool_use_id: 'toolu_02', is_error: true, content: 'private-failure' });
  progress.onEvent({ type: 'tool_result', id: 'unknown', toolName: 'unknown' });
  await progress.finalize();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ toolCallId, toolName, status }) => ({ toolCallId, toolName, status })), [
    { toolCallId: 'toolu_01', toolName: 'read_file', status: undefined },
    { toolCallId: 'toolu_01', toolName: 'read_file', status: 'completed' },
    { toolCallId: 'toolu_02', toolName: 'bash', status: undefined },
    { toolCallId: 'toolu_02', toolName: 'bash', status: 'failed' },
  ]);
  for (const call of calls) {
    assert.equal(call.accountId, msg.accountId);
    assert.equal(call.to, msg.fromUserId);
    assert.equal(call.contextToken, msg.contextToken);
    assert.equal(call.runId, msg.runId);
    assert.equal(call.timeoutMs, 3000);
    assert.doesNotMatch(JSON.stringify(call), /private-(?:input|output|failure)/);
  }
});

test('queue serializes network calls and finalize waits for accepted calls before returning', async () => {
  const calls = [];
  const releases = [];
  let active = 0, maxActive = 0;
  const progress = createReplyProgress({ sendToolProgress: async args => {
    active++; maxActive = Math.max(maxActive, active); calls.push(args);
    await new Promise(resolve => releases.push(resolve));
    active--;
  } }, { ...msg, runId: undefined });
  progress.onEvent({ type: 'tool_use', id: 'call-1', name: 'bash' });
  progress.onEvent({ type: 'tool_result', id: 'call-1' });
  let finalized = false;
  const finishing = progress.finalize().then(() => { finalized = true; });
  progress.onEvent({ type: 'tool_use', id: 'late', name: 'ignored' });
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(finalized, false);
  releases.shift()();
  await turn();
  assert.equal(calls.length, 2);
  assert.equal(finalized, false);
  releases.shift()();
  await finishing;
  assert.equal(finalized, true);
  assert.equal(maxActive, 1);
  assert.equal(calls[0].runId, calls[1].runId);
  assert.ok(calls[0].runId);
  await progress.finalize();
  assert.equal(calls.length, 2);
});

test('a rejected progress request disables further sends without rejecting finalization', async () => {
  let calls = 0;
  const progress = createReplyProgress({ sendToolProgress: async () => { calls++; throw new Error('progress endpoint unavailable'); } }, msg);
  progress.onEvent({ type: 'tool_use', id: 'call-1', name: 'bash' });
  progress.onEvent({ type: 'tool_result', id: 'call-1' });
  progress.onEvent({ type: 'tool_use', id: 'call-2', name: 'read_file' });
  await assert.doesNotReject(progress.finalize());
  assert.equal(calls, 1);
});

test('disabled progress sends nothing and still supplies one run ID', async () => {
  const calls = [];
  const progress = createReplyProgress({ sendToolProgress: async args => calls.push(args) }, { ...msg, runId: undefined }, { enabled: false });
  progress.onEvent({ type: 'tool_use', id: 'call-1', name: 'bash' });
  progress.onEvent({ type: 'tool_result', id: 'call-1' });
  await progress.finalize();
  assert.equal(calls.length, 0);
  assert.ok(progress.runId);
});

test('queue is bounded and never sends an orphan result for a dropped start', async () => {
  const calls = [];
  const progress = createReplyProgress({ sendToolProgress: async args => calls.push(args) }, msg, { maxPending: 4 });
  for (let i = 0; i < 10; i++) progress.onEvent({ type: 'tool_use', id: `call-${i}`, name: 'bash' });
  await turn();
  assert.equal(calls.length, 2);
  progress.onEvent({ type: 'tool_result', id: 'call-9' });
  progress.onEvent({ type: 'tool_result', id: 'call-0' });
  progress.onEvent({ type: 'tool_result', id: 'call-1' });
  await progress.finalize();
  assert.equal(calls.filter(call => call.toolCallId === 'call-9').length, 0);
  assert.equal(calls.length, 4);
  for (const id of ['call-0', 'call-1']) {
    assert.deepEqual(calls.filter(call => call.toolCallId === id).map(call => call.status), [undefined, 'completed']);
  }
});


test('reserved result slots balance accepted starts even when the pending queue is full', async () => {
  const calls = [];
  const progress = createReplyProgress({ sendToolProgress: async args => calls.push(args) }, msg, { maxPending: 4 });
  for (let i = 0; i < 10; i++) progress.onEvent({ type: 'tool_use', id: `call-${i}`, name: 'bash' });
  for (let i = 0; i < 10; i++) progress.onEvent({ type: 'tool_result', id: `call-${i}`, isError: i === 1 });
  await progress.finalize();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => [call.toolCallId, call.status]), [
    ['call-0', undefined], ['call-1', undefined], ['call-0', 'completed'], ['call-1', 'failed'],
  ]);
});
