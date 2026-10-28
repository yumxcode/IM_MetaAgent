/** Detached transport supervisor: bot restart does not stop the runtime process. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWrite, readState } from './durable-store.mjs';

export async function runWorker(directory, { adapterFactory } = {}) {
  const job = readState(path.join(directory, 'request.json'), null);
  if (!job || !job.id) throw new Error('Invalid execution request');
  // Claim before *any* model/tool side effect. A second launcher can never replay it.
  let claim;
  try { claim = fs.openSync(path.join(directory, 'started.json'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try { fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, id: job.id, at: Date.now() })); fs.fsyncSync(claim); }
  finally { fs.closeSync(claim); }
  // Process-local settings, before importing anything that caches model config.
  if (job.runtime.profile) process.env.META_AGENT_CONFIG_FILE = job.runtime.profile;
  if (job.runtime.runtimeDir) process.env.META_AGENT_RUNTIME_DIR = job.runtime.runtimeDir;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  let eventCount = 0;
  const heartbeat = () => {
    atomicWrite(path.join(directory, 'heartbeat.json'), { pid: process.pid, id: job.id, at: Date.now() });
    if (fs.existsSync(path.join(directory, 'cancel.json'))) controller.abort();
  };
  heartbeat();
  const timer = setInterval(heartbeat, 1000);
  let result;
  try {
    if (job.kind === 'clone') {
      result = await new Promise(resolve => {
        if (controller.signal.aborted) { resolve({ ok: false, subtype: 'cancelled', text: '已取消克隆。' }); return; }
        const child = spawn('git', ['clone', '--depth', '1', '--', job.url, job.workspace], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
        let stderr = '', failure, killTimer;
        const kill = signal => {
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
          catch (error) { if (error.code !== 'ESRCH') failure = error; }
        };
        const cancel = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 3000); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(() => controller.abort(), job.runtime.timeoutMs || 600000);
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
        child.once('error', error => { failure = error; });
        child.once('close', code => {
          clearTimeout(timeout); clearTimeout(killTimer); controller.signal.removeEventListener('abort', cancel);
          resolve({ ok: code === 0 && !failure && !controller.signal.aborted,
            text: controller.signal.aborted ? '克隆已取消或超时。' : failure?.message || (code === 0 ? '项目克隆完成。' : stderr),
            subtype: controller.signal.aborted ? 'cancelled' : failure ? 'clone_error' : 'clone' });
        });
      });
    } else {
      const adapter = adapterFactory ? await adapterFactory() : new (await import('./runtime-adapter.mjs')).RuntimeAdapter();
      result = await adapter.execute(job, { signal: controller.signal, onEvent(event) {
        // Persist identity and the latest progress; avoid an unbounded transcript copy.
        if (event.sessionId) atomicWrite(path.join(directory, 'session.json'), { sessionId: event.sessionId });
        if (++eventCount % 10 === 0 || ['tool_use', 'result'].includes(event.type)) {
          atomicWrite(path.join(directory, 'progress.json'), { at: Date.now(), type: event.type,
            toolName: event.toolName, sessionId: event.sessionId });
        }
      } });
    }
  } catch (error) { result = { ok: false, text: '', subtype: controller.signal.aborted ? 'cancelled' : 'worker_error', errors: [error.message] }; }
  finally { clearInterval(timer); process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
  atomicWrite(path.join(directory, 'result.json'), { ...result, requestId: job.id, completedAt: Date.now() });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
