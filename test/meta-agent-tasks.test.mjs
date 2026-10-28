import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTaskRuntime,
  loadOpsRuntime,
  resolveMetaAgentHome,
  resolveTasksProfile,
  runBoundedCommand,
} from '../src/meta-agent-tasks.mjs';

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

test('profile resolution mirrors meta-agent-glm precedence', () => {
  const env = { META_AGENT_HOME: '/test/home' };
  assert.equal(resolveTasksProfile(env), '/test/home/glm_config.json');
  assert.equal(resolveTasksProfile({ ...env, META_AGENT_TASKS_PROFILE: '/custom/glm.json' }), '/custom/glm.json');
  assert.equal(resolveTasksProfile({ ...env, META_AGENT_CONFIG_FILE: '/env/config.json' }), '/env/config.json');
  assert.equal(resolveTasksProfile({ ...env, META_AGENT_TASKS_PROFILE: '/p.json', META_AGENT_CONFIG_FILE: '/c.json' }), '/p.json');
  assert.equal(resolveMetaAgentHome({}), join(homedir(), '.meta-agent'));
});

async function nativeFixture(t, version = '0.11.3') {
  const base = join(process.cwd(), 'node_modules', '.tmp-task-runtime');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'runtime');
  for (const relative of ['dist/core/auto', 'dist/tools/task_ops', 'dist/modes', 'dist/cli/tui']) {
    await mkdir(join(root, relative), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@meta-agent/runtime', version, type: 'module', exports: { './im': { import: './dist/im.js' } } }));
  const entryPath = join(root, 'dist/cli-glm.mjs');
  await writeFile(entryPath, '#!/usr/bin/env node\n');
  await chmod(entryPath, 0o755);
  const bin = join(directory, 'meta-agent-glm');
  await symlink(entryPath, bin);
  const module = (name, body) => writeFile(join(root, 'dist', name), body);
  await module('im.js', `export const IM_RUNTIME_CONTRACT_VERSION = 1;
    export class TasksAgenticSessionStore {}
export class TaskControlService {}
    export function createTaskOpsTools(){return []}
export class AgenticSession {}
    export class TaskManager {}
export function createSubprocessManagedWorkerLauncher(){return {}}
export function makeImageBlockFromFile(){return {}}`);
  return { root, bin, entryPath };
}

test('native runtime discovery follows npm bin symlinks and imports the ops module set', async t => {
  const f = await nativeFixture(t);
  assert.deepEqual(await discoverTaskRuntime({ bin: f.bin }), {
    runtimeDir: await realpath(f.root), entryPath: await realpath(f.entryPath), version: '0.11.3',
  });
  assert.equal((await discoverTaskRuntime({ bin: f.bin, runtimeDir: join(f.root, 'dist') })).runtimeDir, f.root);
  const native = await loadOpsRuntime(f.root);
  for (const name of ['TasksAgenticSessionStore', 'TaskControlService', 'createTaskOpsTools', 'AgenticSession',
    'TaskManager', 'createSubprocessManagedWorkerLauncher']) {
    assert.equal(typeof native[name], 'function', name);
  }
});

test('native runtime discovery rejects outdated packages and missing executables', async t => {
  const outdated = await nativeFixture(t, '0.11.1');
  await assert.rejects(discoverTaskRuntime({ bin: outdated.bin }), />= 0.11.3/);
  await assert.rejects(discoverTaskRuntime({ bin: join(outdated.root, 'missing') }), /无法找到/);
});

test('loadOpsRuntime fails loudly when the runtime misses an ops export', async t => {
  const f = await nativeFixture(t);
  await writeFile(join(f.root, 'dist', 'im.js'), 'export const IM_RUNTIME_CONTRACT_VERSION = 1; export class AgenticSession {} export class TasksAgenticSessionStore {}');
  await assert.rejects(loadOpsRuntime(f.root), /TaskControlService/);
});
