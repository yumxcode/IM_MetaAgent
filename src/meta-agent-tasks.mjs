import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TASK_STATUSES = new Set(['running', 'parked', 'overdue', 'stale-claim', 'orphaned', 'failed', 'finished']);
const ACTIONS = new Set(['run-now', 'cancel', 'kill', 'steer', 'delete']);
const REQUIRED_VERSION = [0, 11, 1];

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
  throw new Error(`无法找到 ${command}。请安装 meta-agent runtime >= 0.11.1，或设置 META_AGENT_TASKS_BIN。`);
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
    throw new Error(`任务管理需要 meta-agent runtime >= 0.11.1，当前为 ${manifest.version ?? '未知版本'}。`);
  }
  return { runtimeDir: root, entryPath, version: manifest.version };
}

async function loadNativeRuntime(runtimeDir) {
  const file = relative => pathToFileURL(join(runtimeDir, 'dist', relative)).href;
  const [actions, manager, activity] = await Promise.all([
    import(file('core/auto/TaskActions.js')),
    import(file('cli/tui/TaskManager.js')),
    import(file('cli/tui/TaskActivityLog.js')),
  ]);
  const loaded = {
    applyTaskAction: actions.applyTaskAction,
    TaskManager: manager.TaskManager,
    createSubprocessManagedWorkerLauncher: manager.createSubprocessManagedWorkerLauncher,
    readTaskActivityLog: activity.readTaskActivityLog,
  };
  for (const [name, value] of Object.entries(loaded)) {
    if (typeof value !== 'function') throw new Error(`meta-agent runtime 缺少 ${name}，请升级到 >= 0.11.1。`);
  }
  return loaded;
}

function taskIdentity(task) {
  if (!task || typeof task.workspace !== 'string' || !task.workspace.trim()
    || typeof task.sessionId !== 'string' || !task.sessionId.trim()) {
    throw new TypeError('任务必须包含完整 workspace 和 sessionId。');
  }
  return `${resolve(task.workspace)}\0${task.sessionId}`;
}

function validTask(task) {
  return task && typeof task === 'object' && !Array.isArray(task)
    && typeof task.workspace === 'string' && isAbsolute(task.workspace)
    && typeof task.sessionId === 'string' && task.sessionId.length > 0
    && TASK_STATUSES.has(task.status);
}

/**
 * Chat adapter for the native task read/control/execution planes.
 * Reads stay CLI-only; imports and managed execution are deferred until needed.
 * runCommand/loadRuntime are injection points so tests never start real work.
 */
export function createTaskBackend(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const bin = opts.bin ?? env.META_AGENT_TASKS_BIN ?? 'meta-agent-glm';
  const home = resolve(env.META_AGENT_HOME?.trim() || join(homedir(), '.meta-agent'));
  const rawProfile = opts.profile ?? env.META_AGENT_TASKS_PROFILE ?? join(home, 'glm_config.json');
  const profile = rawProfile === 'all' ? 'all' : resolve(rawProfile);
  const runtimeDir = opts.runtimeDir ?? env.META_AGENT_TASKS_RUNTIME_DIR;
  const pollMs = opts.pollMs ?? Number(env.META_AGENT_TASKS_POLL_MS ?? 5_000);
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000) {
    throw new TypeError('META_AGENT_TASKS_POLL_MS 必须是至少 1000 的整数毫秒数。');
  }
  const runCommand = opts.runCommand ?? runBoundedCommand;
  const commandOptions = {
    env,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
  let runtimePromise;
  let location;
  let manager;
  let managerLimit = 0;
  let managing = false;
  let closed = false;
  let transition = Promise.resolve();

  const assertOpen = () => {
    if (closed) throw new Error('任务桥接已关闭。');
  };
  const loadRuntime = async () => {
    assertOpen();
    if (!runtimePromise) {
      runtimePromise = (async () => {
        if (opts.loadRuntime) {
          // Test/embedding loaders own their discovery and supply a safe launcher.
          location = { runtimeDir, entryPath: opts.cliEntry ?? bin };
          return await opts.loadRuntime(runtimeDir, location);
        }
        location = await discoverTaskRuntime({ bin, runtimeDir, env });
        return await loadNativeRuntime(location.runtimeDir);
      })();
      runtimePromise.catch(() => { runtimePromise = undefined; });
    }
    return await runtimePromise;
  };

  const list = async () => {
    assertOpen();
    const result = await runCommand(bin, ['tasks', 'list', '--json'], commandOptions);
    if (result.code !== undefined && result.code !== 0) {
      const detail = String(result.stderr ?? '').trim().slice(0, 500);
      throw new Error(`meta-agent tasks 读取失败（退出 ${result.code}）${detail ? `：${detail}` : ''}`);
    }
    let payload;
    try {
      payload = JSON.parse(String(result.stdout ?? ''));
    } catch {
      throw new Error('meta-agent tasks 未返回有效 JSON。请使用 runtime >= 0.11.1。');
    }
    if (!payload || !Array.isArray(payload.tasks) || !payload.tasks.every(validTask)) {
      throw new Error('meta-agent tasks 返回的任务结构无效。');
    }
    return payload.tasks.filter(task => {
      if (profile === 'all') return true;
      const owner = task.profile ?? task.scheduler?.configFile;
      return typeof owner === 'string' && resolve(owner) === profile;
    });
  };

  const freshTask = async task => {
    const identity = taskIdentity(task);
    const matches = (await list()).filter(current => taskIdentity(current) === identity);
    if (matches.length !== 1) return undefined;
    return matches[0];
  };

  const serializeTransition = operation => {
    const next = transition.then(operation);
    transition = next.catch(() => {});
    return next;
  };

  const managerStatus = () => {
    if (!manager) return { enabled: false, running: 0, queued: 0, maxRunning: 0 };
    return { ...manager.snapshot(), enabled: managing };
  };

  return {
    list,
    async action(task, kind, text = '', { confirmed = false, expectedWakeId } = {}) {
      assertOpen();
      if (!ACTIONS.has(kind)) throw new TypeError(`不支持的任务操作：${kind}`);
      if ((kind === 'kill' || kind === 'delete') && confirmed !== true) {
        return { ok: false, message: `${kind} 需要针对当前任务的明确确认。` };
      }
      const current = await freshTask(task);
      if (!current) return { ok: false, message: '任务已不存在或已不属于当前配置，请重新获取任务列表。' };
      if (kind === 'run-now' || kind === 'cancel' || kind === 'kill') {
        const expected = expectedWakeId ?? task.wake?.wakeId;
        if (kind === 'kill' && (typeof expected !== 'string' || !expected)) {
          return { ok: false, message: '中断任务需要确认具体运行轮次，请重新获取任务并确认。' };
        }
        if (expected !== undefined && expected !== current.wake?.wakeId) {
          return { ok: false, message: '任务的运行轮次已变化，此操作未执行；请刷新任务后重新操作。' };
        }
      }
      const native = await loadRuntime();
      if (kind === 'run-now' && manager && managing) return await manager.runNow(current);
      return await native.applyTaskAction(current, kind, text);
    },
    async activity(task, { reportOnly = false } = {}) {
      assertOpen();
      const current = await freshTask(task);
      if (!current) return { entries: [], truncated: false, error: '任务已不存在或已不属于当前配置。' };
      const wakeId = reportOnly
        ? current.lastWakeId
        : current.status === 'running' || current.status === 'stale-claim'
          ? current.wake?.wakeId
          : current.lastWakeId;
      if (typeof wakeId !== 'string' || !wakeId) return { entries: [], truncated: false };
      const hash = createHash('sha256').update(wakeId).digest('hex').slice(0, 24);
      const logPath = join(home, 'managed-auto', 'logs', `${hash}.log`);
      const native = await loadRuntime();
      return { ...await native.readTaskActivityLog(logPath), logPath };
    },
    startManaging(maxRunning = 3) {
      return serializeTransition(async () => {
        assertOpen();
        if (!Number.isSafeInteger(maxRunning) || maxRunning < 1) {
          return { ok: false, message: '托管并发上限必须是正整数。' };
        }
        if (managing) return maxRunning === managerLimit
          ? { ok: true, message: `任务托管已开启，并发上限 ${managerLimit}。` }
          : { ok: false, message: '请先停止托管，再修改并发上限。' };
        if (manager && maxRunning !== managerLimit && manager.snapshot().running > 0) {
          return { ok: false, message: '之前托管的任务仍在运行，请等待结束后修改并发上限。' };
        }
        const native = await loadRuntime();
        if (!manager || managerLimit !== maxRunning) {
          manager = new native.TaskManager({
            maxRunning,
            pollMs,
            collect: list,
            launcher: native.createSubprocessManagedWorkerLauncher({ cli: {}, entryPath: location.entryPath }),
          });
          managerLimit = maxRunning;
        }
        await manager.start();
        managing = true;
        return { ok: true, message: `任务托管已开启，并发上限 ${maxRunning}，到期任务将自动执行。` };
      });
    },
    stopManaging() {
      return serializeTransition(async () => {
        assertOpen();
        if (manager) await manager.stop();
        managing = false;
        return { ok: true, message: '任务托管已停止接收新任务，已运行的任务继续执行。' };
      });
    },
    managerStatus,
    close() {
      return serializeTransition(async () => {
        if (manager) await manager.stop();
        managing = false;
        closed = true;
      });
    },
  };
}
