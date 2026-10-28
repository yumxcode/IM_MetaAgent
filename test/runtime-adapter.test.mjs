import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMetaAgentArgs, runMetaAgent } from '../src/meta-agent-bridge.mjs';
import { loadOpsRuntime } from '../src/meta-agent-tasks.mjs';
import { RuntimeAdapter, readReminderRequests } from '../src/runtime-adapter.mjs';
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

test('talk runs the meta-agent CLI in simple_auto, resumes its session and collects reminder requests', async t => {
  const root = temp(t), workspace = path.join(root, 'chat'), argsFile = path.join(root, 'args.jsonl');
  const bin = script(root, `const fs=require('node:fs'),{execFileSync}=require('node:child_process');
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.META_AGENT_TALK_MARK }) + '\\n');
// Act like the agent: use the reminder helper from the workspace.
const out = execFileSync(process.execPath, ['.im/remind.mjs', 'create', '--text', '喝水', '--cron', '0 15 * * *'], { encoding: 'utf8' });
const bad = (() => { try { execFileSync(process.execPath, ['.im/remind.mjs', 'create', '--text', 'x', '--at', '2000-01-01 08:00']); return 'ok'; } catch (e) { return String(e.stdout); } })();
process.stdout.write(JSON.stringify({ type: 'result', isError: false, subtype: 'success', result: out.trim() + ' | ' + bad.trim(), sessionId: 'chat-session' }) + '\\n');`);
  const adapter = new RuntimeAdapter({ env: { ...process.env, META_AGENT_TALK_MARK: 'env-passed' } });
  const job = { id: 'one', kind: 'talk', prompt: '每天下午三点提醒我喝水', workspace, runtime: { bin, sessionDir: path.join(root, 'sessions') },
    schedules: [{ id: 'R1', kind: 'remind', text: '旧提醒', cron: '0 9 * * *', nextAt: Date.now() + 1000 }] };
  const first = await adapter.execute(job);
  assert.equal(first.ok, true); assert.equal(first.sessionId, 'chat-session');
  assert.match(first.text, /已提交：提醒 · 每天 15:00/); assert.match(first.text, /已过去/);
  assert.deepEqual(first.scheduleOps, [{ type: 'create', kind: 'remind', text: '喝水', cron: '0 15 * * *' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, '.im', 'reminders.json'))).map(s => s.id), ['R1']);
  await adapter.execute({ ...job, id: 'two', prompt: '继续', resumeSessionId: 'chat-session', runtime: { ...job.runtime, maxTurns: 40, maxBudgetUsd: 3 } });
  const [a, b] = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(a.cwd, fs.realpathSync(workspace)); assert.equal(a.env, 'env-passed');
  assert.deepEqual(a.args.slice(0, 4), ['--json', '--yes', '--mode', 'simple_auto']);
  assert.ok(!a.args.includes('--max-turns') && !a.args.includes('--max-budget-usd'), 'meta-agent defaults apply when unset');
  assert.ok(a.args.includes('--system') && !a.args.includes('--resume'));
  assert.match(a.args.at(-1), /^\[当前本机时间：\d{4}-\d{2}-\d{2} 周.+\]\n每天下午三点提醒我喝水$/);
  assert.deepEqual(b.args.slice(b.args.indexOf('--resume'), b.args.indexOf('--resume') + 3), ['--resume', 'chat-session', '--new-goal']);
  assert.equal(b.args[b.args.indexOf('--max-turns') + 1], '40'); assert.equal(b.args[b.args.indexOf('--max-budget-usd') + 1], '3');
});

test('reminder requests are shape-checked before reaching the bot', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'requests.jsonl'), [
    JSON.stringify({ type: 'create', kind: 'talk', text: '简报', cron: '0 8 * * *' }),
    'not json', JSON.stringify({ type: 'create', text: 5, at: 1 }), JSON.stringify({ type: 'cancel', id: 'R2; rm -rf /' }),
    JSON.stringify({ type: 'cancel', id: 'R2' }), JSON.stringify({ type: 'create', kind: 'evil', text: 'x', at: 123 }),
  ].join('\n'));
  assert.deepEqual(readReminderRequests(dir), [
    { type: 'create', kind: 'talk', text: '简报', cron: '0 8 * * *' }, { type: 'cancel', id: 'R2' }, { type: 'create', kind: 'remind', text: 'x', at: 123 }]);
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

test('one runtime root selects both execution CLIs', () => {
  const adapter = new RuntimeAdapter({ env: { META_AGENT_RUNTIME_DIR: '/local/runtime' } });
  assert.equal(adapter.settings('auto').bin, '/local/runtime/dist/cli.mjs');
  assert.equal(adapter.settings('tasks').bin, '/local/runtime/dist/cli-glm.mjs');
});
