import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMetaAgentArgs, runMetaAgent } from '../src/meta-agent-bridge.mjs';
import { loadOpsRuntime } from '../src/meta-agent-tasks.mjs';
import { RuntimeAdapter } from '../src/runtime-adapter.mjs';
import { atomicWrite, readState } from '../src/durable-store.mjs';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-adapter-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function script(root, source) { const file = path.join(root, 'fake-runtime'); fs.writeFileSync(file, '#!/usr/bin/env node\n' + source, { mode: 0o700 }); return file; }

test('lifecycle flags are mutually exclusive and prompt cannot become a CLI flag', () => {
  const args = buildMetaAgentArgs('--help', { mode: 'auto' }); assert.deepEqual(args.slice(-2), ['--', '--help']);
  const follow = buildMetaAgentArgs('补充', { intent: 'steer', resumeSessionId: 's' });
  assert.deepEqual(follow.slice(-4), ['--resume', 's', '--steer', '补充']);
  const continuing = buildMetaAgentArgs('', { intent: 'continue', resumeSessionId: 's' }); assert.equal(continuing.at(-1), '--continue');
  assert.throws(() => buildMetaAgentArgs('new', { resumeSessionId: 'old' }));
  assert.throws(() => buildMetaAgentArgs('old', { intent: 'steer' }));
});

test('JSONL result without final newline is retained and failures do not erase session identity', async t => {
  const root = temp(t), bin = script(root, `process.stdout.write(JSON.stringify({type:'text',text:'partial',sessionId:'sid'})+'\\n');process.stdout.write(JSON.stringify({type:'result',isError:true,subtype:'error_max_turns',result:'partial',sessionId:'sid'}));`);
  const result = await runMetaAgent('work', { bin, workspace: root });
  assert.equal(result.ok, false); assert.equal(result.sessionId, 'sid'); assert.equal(result.text, 'partial'); assert.equal(result.subtype, 'error_max_turns');
});

test('timeout actually kills a child that ignores SIGTERM', async t => {
  const root = temp(t), bin = script(root, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const before = Date.now();
  const result = await runMetaAgent('work', { bin, workspace: root, timeoutMs: 200, killGraceMs: 100 });
  assert.equal(result.subtype, 'timeout'); assert.equal(result.ok, false); assert.ok(Date.now() - before < 3000);
});

test('abort cancels execution and overlarge output cannot grow without bound', async t => {
  const root = temp(t), bin = script(root, `setInterval(()=>{},1000);`), controller = new AbortController();
  const pending = runMetaAgent('work', { bin, workspace: root, signal: controller.signal, killGraceMs: 100 });
  setTimeout(() => controller.abort(), 100); assert.equal((await pending).subtype, 'cancelled');
  fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(5000));setInterval(()=>{},1000);');
  const result = await runMetaAgent('work', { bin, workspace: root, maxOutputBytes: 100, killGraceMs: 100 });
  assert.equal(result.subtype, 'output_limit');
});

test('two supervisors for one request execute once and persist the result after their launcher exits', async t => {
  const root = temp(t), sideEffect = path.join(root, 'effect');
  const bin = script(root, `require('node:fs').appendFileSync(${JSON.stringify(sideEffect)},'once\\n');setTimeout(()=>{process.stdout.write(JSON.stringify({type:'result',isError:false,subtype:'success',result:'done',sessionId:'one'})+'\\n');},150);`);
  const dir = path.join(root, 'e-test');
  atomicWrite(path.join(dir, 'request.json'), { id: 'e-test', kind: 'auto', mode: 'auto', intent: 'new', prompt: 'work', workspace: root, runtime: { bin } });
  const worker = fileURLToPath(new URL('../src/execution-worker.mjs', import.meta.url));
  const code = `const {spawn}=require('node:child_process');for(let i=0;i<2;i++){const c=spawn(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(dir)}],{detached:true,stdio:'ignore'});c.unref();}`;
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', code]); child.once('error', reject); child.once('close', c => c === 0 ? resolve() : reject(new Error('launcher failed'))); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(dir, 'result.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(readState(path.join(dir, 'result.json'), null)?.text, 'done');
  assert.equal(fs.readFileSync(sideEffect, 'utf8'), 'once\n');
});

test('talk persists a separate history with no work tools and replays a saved result without another model call', async t => {
  const root = temp(t), seen = [];
  class FakeSession {
    constructor(opts) { this.opts = opts; seen.push(opts); }
    async *submit(text) { yield { type: 'text', text: '答复' }; yield { type: 'result', isError: false, subtype: 'success', result: '答复' }; }
    getMessages() { return [...this.opts.initialMessages, { role: 'assistant', content: '答复' }]; }
    getEstimatedCost() { return 0.1; }
    async dispose() {}
    interrupt() {}
  }
  const adapter = new RuntimeAdapter(); adapter.native = async () => ({ AgenticSession: FakeSession });
  const job = { id: 'one', kind: 'talk', prompt: 'hello', workspace: root, historyFile: path.join(root, 'talk.json'), runtime: {} };
  assert.equal((await adapter.execute(job)).text, '答复'); await adapter.execute(job);
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].tools, []);
  await adapter.execute({ ...job, id: 'two' }); assert.equal(seen[1].initialMessages.length, 1);
});

test('runtime settings remain separate for chat, work and operations', () => {
  const adapter = new RuntimeAdapter({ env: { META_AGENT_HOME: '/private/home', META_AGENT_CONFIG_FILE: '/work.json', META_AGENT_TASKS_PROFILE: '/tasks.json', META_AGENT_TALK_PROFILE: '/talk.json' } });
  assert.equal(adapter.settings('talk').profile, '/talk.json'); assert.equal(adapter.settings('auto').profile, '/work.json'); assert.equal(adapter.settings('tasks').profile, '/tasks.json');
});

test('real runtime exposes a versioned public embedding contract', { skip: !process.env.IM_TEST_RUNTIME_DIR }, async () => {
  const native = await loadOpsRuntime(process.env.IM_TEST_RUNTIME_DIR);
  assert.equal(native.IM_RUNTIME_CONTRACT_VERSION, 1);
  for (const name of ['AgenticSession', 'TaskControlService', 'TasksAgenticSessionStore', 'TaskManager', 'createTaskOpsTools', 'createSubprocessManagedWorkerLauncher', 'makeImageBlockFromFile']) assert.equal(typeof native[name], 'function');
});


test('continuation checks runtime ownership before launching an execution', async t => {
  const root = temp(t), effect = path.join(root, 'effect');
  const job = { kind: 'auto', intent: 'continue', mode: 'auto', prompt: '', workspace: root, resumeSessionId: 's' };
  const adapter = new RuntimeAdapter();
  for (const status of ['running', 'stale-claim', null]) {
    const bin = script(root, `if(process.argv[2]==='call')process.stdout.write(JSON.stringify({ok:true,data:{task:{status:${JSON.stringify(status)}}}}));else require('node:fs').writeFileSync(${JSON.stringify(effect)},'bad');`);
    await assert.rejects(adapter.execute({ ...job, runtime: { bin } }), /核验|运行/);
    assert.equal(fs.existsSync(effect), false);
  }
  const bin = script(root, `if(process.argv[2]==='call')process.stdout.write(JSON.stringify({ok:true,data:{task:{status:'parked'}}}));else process.stdout.write(JSON.stringify({type:'result',isError:false,subtype:'success',result:'resumed'}));`);
  assert.equal((await adapter.execute({ ...job, runtime: { bin } })).text, 'resumed');
});

test('talk delivers image content through the public image constructor', async t => {
  const root = temp(t), submitted = [], image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } };
  class Session {
    async *submit(prompt) { submitted.push(prompt); yield { type: 'result', isError: false, result: 'image read' }; }
    getMessages() { return []; } getEstimatedCost() { return 0; } async dispose() {} interrupt() {}
  }
  const adapter = new RuntimeAdapter();
  adapter.native = async () => ({ AgenticSession: Session, makeImageBlockFromFile: async file => { assert.equal(file, '/input.png'); return image; } });
  await adapter.execute({ id: 'image', kind: 'talk', prompt: '描述图片', mediaPath: '/input.png', workspace: root, historyFile: path.join(root, 'chat.json'), runtime: {} });
  assert.deepEqual(submitted[0], [{ type: 'text', text: '描述图片' }, image]);
});

test('one runtime root selects both execution CLIs', () => {
  const adapter = new RuntimeAdapter({ env: { META_AGENT_RUNTIME_DIR: '/local/runtime' } });
  assert.equal(adapter.settings('auto').bin, '/local/runtime/dist/cli.mjs');
  assert.equal(adapter.settings('tasks').bin, '/local/runtime/dist/cli-glm.mjs');
});
