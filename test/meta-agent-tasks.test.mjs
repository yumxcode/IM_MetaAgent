import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTaskBackend,
  discoverTaskRuntime,
  runBoundedCommand,
} from '../src/meta-agent-tasks.mjs';

const PROFILE = '/test/meta-agent/glm_config.json';
const task = (extra = {}) => ({
  workspace: '/test/project', sessionId: 'session-full-id', status: 'parked',
  profile: PROFILE, scheduler: { alive: false },
  wake: { wakeId: 'wake-current', fireAt: 123 },
  progress: { completedSteps: [], pendingTodos: [], artifacts: [] },
  ...extra,
});

function fixture(initialTasks = [task()]) {
  let tasks = initialTasks;
  let running = 0;
  const calls = { commands: [], imports: 0, constructions: 0, managerOptions: [], starts: 0, collected: [], stops: 0, actions: [], runs: [], logs: [], launchers: [] };
  const runtime = {
    async applyTaskAction(selected, kind, text) {
      calls.actions.push({ selected, kind, text });
      return { ok: selected.status !== 'finished', message: selected.status };
    },
    async readTaskActivityLog(logPath) {
      calls.logs.push(logPath);
      return { entries: [{ kind: 'agent', text: 'latest progress' }], truncated: true, report: { text: 'completed report' } };
    },
    createSubprocessManagedWorkerLauncher(options) {
      calls.launchers.push(options);
      return () => { throw new Error('No actual worker may launch in unit tests'); };
    },
    TaskManager: class {
      constructor(options) {
        calls.constructions++;
        calls.managerOptions.push(options);
        this.options = options;
      }
      async start() {
        calls.starts++;
        this.collected = await this.options.collect();
        calls.collected.push(this.collected);
      }
      async stop() { calls.stops++; }
      snapshot() { return { enabled: true, running, queued: 0, maxRunning: this.options.maxRunning }; }
      async runNow(selected) { calls.runs.push(selected); return { ok: true, message: 'managed' }; }
    },
  };
  const options = {
    bin: '/fake/meta-agent-glm', profile: PROFILE, env: { META_AGENT_HOME: '/test/meta-agent' },
    async runCommand(command, args, opts) {
      calls.commands.push({ command, args, opts });
      return { stdout: JSON.stringify({ tasks }), stderr: '', code: 0 };
    },
    async loadRuntime() { calls.imports++; return runtime; },
  };
  return { calls, options, runtime, setTasks(value) { tasks = value; }, setRunning(value) { running = value; } };
}

test('list uses fixed JSON CLI arguments and exact owner profile, with scheduler legacy ownership', async () => {
  const f = fixture([
    task(),
    task({ sessionId: 'legacy', profile: undefined, scheduler: { configFile: PROFILE } }),
    task({ sessionId: 'other', profile: '/other/glm_config.json', scheduler: { configFile: PROFILE } }),
    task({ sessionId: 'unknown', profile: undefined }),
  ]);
  const backend = createTaskBackend(f.options);
  assert.deepEqual((await backend.list()).map(item => item.sessionId), ['session-full-id', 'legacy']);
  assert.deepEqual(f.calls.commands[0].args, ['tasks', 'list', '--json']);
  assert.equal(f.calls.commands[0].command, '/fake/meta-agent-glm');
  assert.equal(f.calls.imports, 0);
  assert.equal(f.calls.constructions, 0);
  assert.equal(f.calls.starts, 0);
  assert.deepEqual(backend.managerStatus(), { enabled: false, running: 0, queued: 0, maxRunning: 0 });
  assert.equal((await createTaskBackend({ ...f.options, profile: 'all' }).list()).length, 4);
});

test('environment overrides select CLI and profile without importing runtime during listing', async () => {
  const f = fixture([task({ profile: '/custom/profile.json' })]);
  const backend = createTaskBackend({
    ...f.options, bin: undefined, profile: undefined,
    env: { META_AGENT_TASKS_BIN: '/custom/bin', META_AGENT_TASKS_PROFILE: '/custom/profile.json' },
  });
  assert.equal((await backend.list()).length, 1);
  assert.equal(f.calls.commands[0].command, '/custom/bin');
  assert.equal(f.calls.imports, 0);
});

test('JSON and exit failures are explicit instead of appearing as an empty task list', async () => {
  for (const result of [
    { code: 1, stderr: 'scheduler read failed', stdout: '' },
    { code: 0, stdout: 'not json' },
    { code: 0, stdout: JSON.stringify({ tasks: [{ workspace: '..', sessionId: 's', status: 'running' }] }) },
  ]) {
    const backend = createTaskBackend({ runCommand: async () => result });
    await assert.rejects(backend.list());
  }
});

test('controls reread full workspace/session identity and use the latest state', async () => {
  const stale = task({ status: 'running' });
  const f = fixture([task({ status: 'finished' }), task({ workspace: '/test/other', status: 'running' })]);
  const backend = createTaskBackend(f.options);
  const result = await backend.action(stale, 'steer', '用户的新指令');
  assert.equal(result.ok, false);
  assert.equal(f.calls.actions[0].selected.workspace, '/test/project');
  assert.equal(f.calls.actions[0].selected.status, 'finished');
  assert.equal(f.calls.actions[0].text, '用户的新指令');
  assert.equal(f.calls.starts, 0);
  f.setTasks([task({ workspace: '/test/other', status: 'running' })]);
  assert.equal((await backend.action(stale, 'cancel')).ok, false);
  assert.equal(f.calls.actions.length, 1);
});

test('destructive actions require literal explicit confirmation and still refresh their target', async () => {
  const f = fixture([task({ status: 'running' })]);
  const backend = createTaskBackend(f.options);
  for (const kind of ['kill', 'delete']) {
    assert.equal((await backend.action(task(), kind)).ok, false);
    assert.equal((await backend.action(task(), kind, '', { confirmed: 'yes' })).ok, false);
  }
  assert.equal(f.calls.imports, 0);
  assert.equal(f.calls.commands.length, 0);
  await backend.action(task(), 'kill', '', { confirmed: true });
  assert.equal(f.calls.actions[0].kind, 'kill');
  assert.equal(f.calls.actions[0].selected.status, 'running');
  await assert.rejects(backend.action(task(), 'shell'), /不支持/);
});

test('wake controls reject a changed round and old kill confirmations cannot interrupt a new wake', async () => {
  const f = fixture([task({ status: 'running', wake: { wakeId: 'new-round' } })]);
  const backend = createTaskBackend(f.options);
  const oldRound = task({ status: 'running', wake: { wakeId: 'old-round' } });
  for (const kind of ['run-now', 'cancel', 'kill']) {
    const result = await backend.action(oldRound, kind, '', { confirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.message, /轮次已变化/);
  }
  assert.equal((await backend.action(oldRound, 'kill', '', {
    confirmed: true, expectedWakeId: 'old-round',
  })).ok, false);
  assert.equal((await backend.action(task({ wake: undefined }), 'kill', '', {
    confirmed: true,
  })).ok, false);
  assert.equal(f.calls.imports, 0);
  assert.equal(f.calls.actions.length, 0);
  await backend.action(oldRound, 'kill', '', { confirmed: true, expectedWakeId: 'new-round' });
  assert.equal(f.calls.actions.length, 1);
  assert.equal(f.calls.actions[0].selected.wake.wakeId, 'new-round');
});

test('activity reads bounded native logs for the refreshed current or completed wake without starting a manager', async () => {
  const f = fixture([task({ status: 'running', wake: { wakeId: '../../current-wake' }, lastWakeId: 'older' })]);
  const backend = createTaskBackend(f.options);
  const feed = await backend.activity(task());
  const hash = createHash('sha256').update('../../current-wake').digest('hex').slice(0, 24);
  assert.equal(feed.logPath, `/test/meta-agent/managed-auto/logs/${hash}.log`);
  assert.equal(feed.report.text, 'completed report');
  assert.equal(f.calls.constructions, 0);
  assert.equal(f.calls.starts, 0);
  f.setTasks([task({ status: 'finished', lastWakeId: 'latest-completed' })]);
  await backend.activity(task());
  assert.ok(f.calls.logs[1].endsWith(`${createHash('sha256').update('latest-completed').digest('hex').slice(0, 24)}.log`));
  f.setTasks([]);
  assert.ok((await backend.activity(task())).error);
  assert.equal(f.calls.logs.length, 2);
});

test('report lookup chooses the latest completed wake while progress follows the current running wake', async () => {
  const f = fixture([task({
    status: 'running', wake: { wakeId: 'currently-running' }, lastWakeId: 'most-recent-completed',
  })]);
  const backend = createTaskBackend(f.options);
  const report = await backend.activity(task(), { reportOnly: true });
  const progress = await backend.activity(task());
  const hash = wakeId => createHash('sha256').update(wakeId).digest('hex').slice(0, 24);
  assert.ok(report.logPath.endsWith(`${hash('most-recent-completed')}.log`));
  assert.ok(progress.logPath.endsWith(`${hash('currently-running')}.log`));
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.constructions, 0);
});

test('managed execution starts only on explicit request, serializes concurrent starts and survives stop/resume', async () => {
  const f = fixture([task(), task({ sessionId: 'other-profile', profile: '/other.json' })]);
  const backend = createTaskBackend(f.options);
  assert.equal((await backend.startManaging(0)).ok, false);
  assert.equal(f.calls.imports, 0);
  const starts = await Promise.all([backend.startManaging(2), backend.startManaging(2)]);
  assert.ok(starts.every(result => result.ok));
  assert.equal(f.calls.constructions, 1);
  assert.equal(f.calls.starts, 1);
  assert.equal(f.calls.managerOptions[0].pollMs, 5_000);
  assert.equal(f.calls.collected[0].length, 1);
  assert.deepEqual(f.calls.launchers[0], { cli: {}, entryPath: '/fake/meta-agent-glm' });
  assert.equal(backend.managerStatus().enabled, true);
  assert.equal((await backend.startManaging(3)).ok, false);
  assert.equal((await backend.action(task(), 'run-now')).message, 'managed');
  assert.equal(f.calls.actions.length, 0);
  f.setRunning(1);
  await backend.stopManaging();
  assert.equal(backend.managerStatus().enabled, false);
  assert.equal(backend.managerStatus().running, 1);
  assert.equal((await backend.startManaging(3)).ok, false);
  await backend.action(task(), 'run-now');
  assert.equal(f.calls.actions[0].kind, 'run-now');
  await backend.startManaging(2);
  assert.equal(f.calls.constructions, 1);
  assert.equal(f.calls.starts, 2);
  assert.equal(backend.managerStatus().running, 1);
  await backend.close();
  assert.equal(backend.managerStatus().enabled, false);
  await assert.rejects(backend.list(), /关闭/);
});

test('subprocess runner enforces a byte cap and a real wall-clock timeout', async () => {
  const result = await runBoundedCommand(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.code, 0);
  await assert.rejects(runBoundedCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    maxOutputBytes: 1024,
  }), /exceeded/);
  await assert.rejects(runBoundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100,
  }), /timed out/);
});

async function nativeFixture(t, version = '0.11.1') {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-task-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'runtime');
  await mkdir(join(root, 'dist', 'core', 'auto'), { recursive: true });
  await mkdir(join(root, 'dist', 'cli', 'tui'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@meta-agent/runtime', version, type: 'module' }));
  const entryPath = join(root, 'dist', 'cli-glm.mjs');
  await writeFile(entryPath, '#!/usr/bin/env node\n');
  await chmod(entryPath, 0o755);
  const bin = join(directory, 'meta-agent-glm');
  await symlink(entryPath, bin);
  await writeFile(join(root, 'dist', 'core', 'auto', 'TaskActions.js'), 'export async function applyTaskAction(task,kind){return {ok:true,message:kind+":"+task.sessionId}}');
  await writeFile(join(root, 'dist', 'cli', 'tui', 'TaskActivityLog.js'), 'export async function readTaskActivityLog(){return {entries:[],truncated:false,report:{text:"native report"}}}');
  await writeFile(join(root, 'dist', 'cli', 'tui', 'TaskManager.js'), `
    export function createSubprocessManagedWorkerLauncher(){throw new Error('Read actions must never construct workers')}
    export class TaskManager {constructor(){throw new Error('Read actions must never start a manager')}}
  `);
  return { root, bin, entryPath };
}

test('native runtime discovery follows npm bin symlinks and imports installed internal modules', async t => {
  const f = await nativeFixture(t);
  assert.deepEqual(await discoverTaskRuntime({ bin: f.bin }), {
    runtimeDir: await realpath(f.root), entryPath: await realpath(f.entryPath), version: '0.11.1',
  });
  assert.equal((await discoverTaskRuntime({ bin: f.bin, runtimeDir: join(f.root, 'dist') })).runtimeDir, f.root);
  const backend = createTaskBackend({
    bin: f.bin, profile: PROFILE,
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ tasks: [task({ lastWakeId: 'done', status: 'finished' })] }) }),
  });
  assert.equal((await backend.action(task(), 'cancel')).message, 'cancel:session-full-id');
  assert.equal((await backend.activity(task())).report.text, 'native report');
  assert.equal(backend.managerStatus().enabled, false);
});

test('native runtime discovery rejects outdated packages and missing executables', async t => {
  const f = await nativeFixture(t, '0.11.0');
  await assert.rejects(discoverTaskRuntime({ bin: f.bin }), />= 0.11.1/);
  await assert.rejects(discoverTaskRuntime({ bin: join(f.root, 'missing') }), /无法找到/);
});
