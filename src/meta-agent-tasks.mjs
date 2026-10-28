import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REQUIRED_VERSION = [0, 11, 3];

/** Run a fixed executable and argument array, without a shell or unbounded output. */
export function runBoundedCommand(command, args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  env = process.env,
} = {}) {
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(result);
    };
    const stop = message => {
      child.kill('SIGKILL');
      finish(new Error(message));
    };
    const append = (chunks, chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stop(`meta-agent tasks output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      chunks.push(chunk);
    };
    const timer = setTimeout(() => stop(`meta-agent tasks timed out after ${timeoutMs} ms`), timeoutMs);
    child.stdout.on('data', chunk => append(out, chunk));
    child.stderr.on('data', chunk => append(err, chunk));
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, {
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      code,
      signal,
    }));
  });
}

async function resolveExecutable(command, env) {
  const candidates = command.includes('/') || isAbsolute(command)
    ? [resolve(command)]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`无法找到 ${command}。请安装 meta-agent runtime >= 0.11.3，或设置 META_AGENT_TASKS_BIN。`);
}

function supportsRuntimeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let i = 0; i < REQUIRED_VERSION.length; i++) {
    if (actual[i] !== REQUIRED_VERSION[i]) return actual[i] > REQUIRED_VERSION[i];
  }
  return true;
}

/** Locate the installed package behind an npm bin symlink, or an explicit root. */
export async function discoverTaskRuntime({ bin = 'meta-agent-glm', runtimeDir, env = process.env } = {}) {
  const entryPath = await resolveExecutable(bin, env);
  let root = runtimeDir ? resolve(runtimeDir) : dirname(entryPath);
  if (runtimeDir && root.endsWith('/dist')) root = dirname(root);
  let manifest;
  while (true) {
    try {
      const candidate = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (candidate.name === '@meta-agent/runtime') {
        manifest = candidate;
        break;
      }
    } catch {
      // Keep walking from the real CLI entry, not the npm bin directory.
    }
    if (runtimeDir || dirname(root) === root) break;
    root = dirname(root);
  }
  if (!manifest) {
    throw new Error('无法定位 @meta-agent/runtime。请将 META_AGENT_TASKS_RUNTIME_DIR 设为已安装包的根目录。');
  }
  if (!supportsRuntimeVersion(manifest.version)) {
    throw new Error(`任务运维控制台需要 meta-agent runtime >= 0.11.3（tasks --agentic），当前为 ${manifest.version ?? '未知版本'}。`);
  }
  return { runtimeDir: root, entryPath, version: manifest.version };
}

/**
 * Native modules behind `tasks --agentic`: the 24-hour ops session store, the
 * shared control plane, its model-facing tools, the agentic session itself and
 * the managed worker launcher. Imports are deferred until the console is used.
 */
export async function loadOpsRuntime(runtimeDir) {
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['./im']?.import;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.split('/').includes('..')) {
    throw new Error('runtime 缺少公开的 @meta-agent/runtime/im 接口，请更新并构建 runtime。');
  }
  const loaded = await import(pathToFileURL(join(runtimeDir, entry)).href);
  if (loaded.IM_RUNTIME_CONTRACT_VERSION !== 1) throw new Error('不支持的 runtime IM 契约版本');
  for (const name of ['AgenticSession', 'TasksAgenticSessionStore', 'TaskControlService', 'createTaskOpsTools', 'TaskManager', 'createSubprocessManagedWorkerLauncher', 'makeImageBlockFromFile']) {
    if (typeof loaded[name] !== 'function') throw new Error(`runtime IM 接口缺少 ${name}`);
  }
  return loaded;
}

/**
 * The runtime's public main entry (package export "."), used for optional
 * tool factories that the IM contract does not re-export (web_search / web_fetch).
 */
export async function loadRuntimeMain(runtimeDir) {
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.']?.import ?? manifest.main;
  if (typeof entry !== 'string' || entry.split('/').includes('..')) throw new Error('runtime 缺少公开主入口');
  return import(pathToFileURL(join(runtimeDir, entry)).href);
}

/** Resolve ~/.meta-agent (or META_AGENT_HOME) exactly like the runtime. */
export function resolveMetaAgentHome(env = process.env) {
  return resolve(env.META_AGENT_HOME?.trim() || join(homedir(), '.meta-agent'));
}

/** Resolve the tasks console profile/model config path exactly like meta-agent-glm. */
export function resolveTasksProfile(env = process.env, opts = {}) {
  const home = resolveMetaAgentHome(env);
  const raw = opts.profile ?? (env.META_AGENT_TASKS_PROFILE?.trim() || env.META_AGENT_CONFIG_FILE?.trim() || join(home, 'glm_config.json'));
  return resolve(raw);
}
