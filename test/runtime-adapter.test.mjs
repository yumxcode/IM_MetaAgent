import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMetaAgentArgs, runMetaAgent, metaAgentEnv, describeRunSubtype } from '../src/meta-agent-bridge.mjs';
import { loadOpsRuntime } from '../src/meta-agent-tasks.mjs';
import { RuntimeAdapter, readReminderRequests } from '../src/runtime-adapter.mjs';
import { resolveRuntimeCli, RETIRED_CLI_KEYS } from '../src/runtime-cli.mjs';
import { createHumanTaskApi } from '../src/human-task-api.mjs';
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

test('abort cancels execution', async t => {
  const root = temp(t), bin = script(root, `setInterval(()=>{},1000);`), controller = new AbortController();
  const pending = runMetaAgent('work', { bin, workspace: root, signal: controller.signal, killGraceMs: 100 });
  setTimeout(() => controller.abort(), 100); assert.equal((await pending).subtype, 'cancelled');
});

test('a long stream is never killed for its total size (regression: A1 output_limit)', async t => {
  // 2000 tool events of ~2.5 KB each ≈ 5 MB — more than the old 4 MiB cumulative cap.
  const root = temp(t), bin = script(root, `const pad='y'.repeat(2500);
for(let i=0;i<2000;i++)process.stdout.write(JSON.stringify({type:'tool_result',toolUseId:'t'+i,content:pad,isError:false,sessionId:'sid'})+'\\n');
process.stdout.write(JSON.stringify({type:'result',isError:false,subtype:'success',result:'done',sessionId:'sid'})+'\\n');`);
  let seen = 0;
  const result = await runMetaAgent('work', { bin, workspace: root, onEvent: e => { if (e.type === 'tool_result') seen++; } });
  assert.equal(result.ok, true); assert.equal(result.subtype, 'success'); assert.equal(result.text, 'done');
  assert.equal(seen, 2000); assert.equal(result.droppedLines, undefined);
});

test('one oversized line is skipped, not fatal, whether it ends in a newline or at EOF', async t => {
  const root = temp(t), bin = script(root, `const w=s=>process.stdout.write(s);
w(JSON.stringify({type:'text',text:'a',sessionId:'sid'})+'\\n');
w('{"type":"tool_result","content":"'); for(let i=0;i<20;i++) w('z'.repeat(500)); w('"}\\n');
w(JSON.stringify({type:'result',isError:false,subtype:'success',result:'kept',sessionId:'sid'})+'\\n');`);
  const result = await runMetaAgent('work', { bin, workspace: root, maxLineBytes: 4096 });
  assert.equal(result.ok, true); assert.equal(result.text, 'kept'); assert.equal(result.droppedLines, 1);
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'text',text:'partial',sessionId:'sid'})+'\\n');process.stdout.write('{"type":"result","result":"'+'q'.repeat(10000));`);
  const tail = await runMetaAgent('work', { bin, workspace: root, maxLineBytes: 4096 });
  assert.equal(tail.ok, false); assert.equal(tail.subtype, 'no_result'); assert.equal(tail.text, 'partial'); assert.equal(tail.droppedLines, 1);
  assert.match(tail.errors.join('\n'), /跳过了 1 条/);
});

test('streamed text fallback keeps a bounded tail', async t => {
  const root = temp(t), bin = script(root, `for(let i=0;i<300;i++)process.stdout.write(JSON.stringify({type:'text',text:String(i%10).repeat(100),sessionId:'sid'})+'\\n');`);
  const result = await runMetaAgent('work', { bin, workspace: root, maxTextChars: 1000 });
  assert.ok(result.text.length <= 2000); assert.ok(result.text.endsWith('9'.repeat(100)));
});

test('lean JSON events are requested through the environment and an operator value wins', async t => {
  const root = temp(t), bin = script(root, `process.stdout.write(JSON.stringify({type:'result',isError:false,subtype:'success',result:String(process.env.META_AGENT_JSON_EVENTS),sessionId:'sid'})+'\\n');`);
  assert.equal((await runMetaAgent('work', { bin, workspace: root, env: { PATH: process.env.PATH } })).text, 'lean');
  assert.equal((await runMetaAgent('work', { bin, workspace: root, env: { PATH: process.env.PATH, META_AGENT_JSON_EVENTS: 'full' } })).text, 'full');
  assert.equal(buildMetaAgentArgs('x').includes('--json-events'), false); // older runtimes reject unknown flags
  const base = { A: '1' }; assert.notEqual(metaAgentEnv(base), base); assert.equal(base.META_AGENT_JSON_EVENTS, undefined);
});

test('run subtypes are explained in Chinese; output_limit is no longer misread as a model limit', () => {
  assert.match(describeRunSubtype('output_limit'), /^output_limit（.*与模型输出长度无关/);
  assert.match(describeRunSubtype('error_max_output_tokens'), /token 上限/);
  assert.equal(describeRunSubtype('something_new'), 'something_new');
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
  assert.deepEqual(first.scheduleOps, [{ type: 'create', kind: 'remind', text: '喝水', cron: '0 15 * * *', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }]);
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

test('every route resolves to one CLI and one config; retired per-route keys are ignored', () => {
  const kinds = ['auto', 'talk', 'tasks'];
  const same = env => { const adapter = new RuntimeAdapter({ env }); const all = kinds.map(k => adapter.settings(k)); all.forEach(s => assert.deepEqual(s, all[0])); return all[0]; };
  const retired = { META_AGENT_TASKS_PROFILE: '/tasks.json', META_AGENT_TALK_PROFILE: '/talk.json', META_AGENT_TASKS_BIN: '/x/meta-agent-glm', META_AGENT_HUMAN_BIN: '/y' };
  assert.deepEqual(same({ META_AGENT_HOME: '/private/home', ...retired }), { cli: 'meta-agent', bin: 'meta-agent', profile: '/private/home/config.json', runtimeDir: undefined });
  assert.deepEqual(same({ META_AGENT_HOME: '/h', META_AGENT_CLI: 'meta-agent-glm', META_AGENT_RUNTIME_DIR: '/rt' }), { cli: 'meta-agent-glm', bin: '/rt/dist/cli-glm.mjs', profile: '/h/glm_config.json', runtimeDir: '/rt' });
  assert.equal(same({ META_AGENT_CLI: 'meta-agent-glm', META_AGENT_CONFIG_FILE: '/work.json', META_AGENT_BIN: '/opt/ma' }).profile, '/work.json');
  const r = resolveRuntimeCli({ META_AGENT_HOME: '/h', ...retired });
  assert.deepEqual(r.retired, Object.keys(retired).sort((a, b) => RETIRED_CLI_KEYS.indexOf(a) - RETIRED_CLI_KEYS.indexOf(b)));
  assert.match(r.problems[0], /已停用并被忽略.*META_AGENT_CLI=meta-agent-glm/);
});

test('META_AGENT_CLI is validated and the old runtime-dir name still works with a hint', () => {
  const bad = resolveRuntimeCli({ META_AGENT_HOME: '/h', META_AGENT_CLI: 'glm' });
  assert.equal(bad.cli, 'meta-agent'); assert.match(bad.problems[0], /META_AGENT_CLI=glm 无效/);
  assert.equal(resolveRuntimeCli({ META_AGENT_CLI: ' Meta-Agent-GLM ' }).cli, 'meta-agent-glm');
  const legacy = resolveRuntimeCli({ META_AGENT_HOME: '/h', META_AGENT_TASKS_RUNTIME_DIR: '/old/rt' });
  assert.equal(legacy.bin, '/old/rt/dist/cli.mjs'); assert.match(legacy.problems.join(), /改为 META_AGENT_RUNTIME_DIR/);
  assert.equal(resolveRuntimeCli({ META_AGENT_RUNTIME_DIR: '/new', META_AGENT_TASKS_RUNTIME_DIR: '/old' }).runtimeDir, '/new');
  assert.equal(resolveRuntimeCli({}, { platform: 'win32' }).bin, 'meta-agent.cmd');
  assert.equal(resolveRuntimeCli({ META_AGENT_CONFIG_FILE: '~/x.json' }).profile, path.join(os.homedir(), 'x.json'));
});

test('children always receive the resolved config explicitly', async t => {
  const root = temp(t), bin = script(root, `process.stdout.write(JSON.stringify({type:'result',isError:false,subtype:'success',result:process.env.META_AGENT_CONFIG_FILE,sessionId:'s'})+'\\n');`);
  const adapter = new RuntimeAdapter({ env: { PATH: process.env.PATH, META_AGENT_HOME: root, META_AGENT_CLI: 'meta-agent-glm' } });
  const talk = await adapter.execute({ id: 't', kind: 'talk', prompt: 'hi', workspace: path.join(root, 'chat'), runtime: { bin } });
  assert.equal(talk.text, path.join(root, 'glm_config.json'));
  const auto = await adapter.execute({ id: 'a', kind: 'auto', intent: 'new', mode: 'auto', prompt: 'go', workspace: root, runtime: { bin, profile: '/snapshot.json' } });
  assert.equal(auto.text, '/snapshot.json');
  let seen;
  const human = createHumanTaskApi({ env: { META_AGENT_HOME: root, META_AGENT_CLI: 'meta-agent-glm', META_AGENT_RUNTIME_DIR: '/rt' }, run: async (file, args, opts) => { seen = { file, config: opts.env.META_AGENT_CONFIG_FILE }; return { code: 0, stdout: '{"ok":true,"data":{}}' }; } });
  await human('human_task.list', {});
  assert.deepEqual(seen, { file: '/rt/dist/cli-glm.mjs', config: path.join(root, 'glm_config.json') });
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

test('one runtime root selects the same CLI for every route', () => {
  const adapter = new RuntimeAdapter({ env: { META_AGENT_RUNTIME_DIR: '/local/runtime' } });
  assert.equal(adapter.settings('auto').bin, '/local/runtime/dist/cli.mjs');
  assert.equal(adapter.settings('tasks').bin, '/local/runtime/dist/cli.mjs');
  assert.equal(new RuntimeAdapter({ env: { META_AGENT_RUNTIME_DIR: '/local/runtime', META_AGENT_CLI: 'meta-agent-glm' } }).settings('talk').bin, '/local/runtime/dist/cli-glm.mjs');
});
