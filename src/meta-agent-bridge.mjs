/** CLI transport. Every logical task owns its lifecycle and configuration. */
import { spawn } from 'node:child_process';

export const resolveMetaAgentBin = () => process.env.META_AGENT_BIN || (process.platform === 'win32' ? 'meta-agent.cmd' : 'meta-agent');

export function checkMetaAgent({ bin = resolveMetaAgentBin(), env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, reason: 'version_check_timeout' }); }, 10000);
    child.stdout?.on('data', data => { if (output.length < 4096) output += data; });
    child.once('error', error => finish({ ok: false, reason: error.code || error.message }));
    child.once('close', code => finish({ ok: code === 0, version: output.trim(), code }));
  });
}

export function buildMetaAgentArgs(prompt, opts = {}) {
  const { mode = 'auto', maxTurns = 30, workspace, sessionDir, resumeSessionId, intent = 'new', images = [] } = opts;
  if (!['new', 'continue', 'steer', 'new_goal'].includes(intent)) throw new Error('Unknown execution intent');
  if (intent !== 'new' && !resumeSessionId) throw new Error('Continuation requires a session ID');
  if (intent === 'new' && resumeSessionId) throw new Error('A new task must not resume another task');
  if (intent !== 'continue' && !String(prompt || '').trim()) throw new Error('empty prompt');
  const args = ['--json', '--yes', '--mode', mode, '--max-turns', String(maxTurns)];
  if (workspace) args.push('--workspace', workspace);
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (opts.systemPrompt) args.push('--system', opts.systemPrompt);
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  for (const image of images) args.push('--image', image);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (intent === 'continue') args.push('--continue');
  else if (intent === 'steer') args.push('--steer', prompt);
  else if (intent === 'new_goal') args.push('--new-goal', prompt);
  else args.push('--', prompt); // Model text can never become CLI options.
  return args;
}

export async function runMetaAgent(prompt, opts = {}) {
  let args;
  try { args = buildMetaAgentArgs(prompt, opts); }
  catch (error) { return { ok: false, isError: true, subtype: 'invalid_input', text: '', errors: [error.message] }; }
  return new Promise(resolve => {
    let child, buffer = '', stderr = '', text = '', result, sessionId, timer, killTimer;
    let closed = false, timedOut = false, cancelled = false, overflow = false, parseError;
    const cap = opts.maxOutputBytes ?? 4 * 1024 * 1024;
    let bytes = 0;
    const stop = reason => {
      if (closed || !child) return;
      timedOut ||= reason === 'timeout'; cancelled ||= reason === 'cancelled'; overflow ||= reason === 'output_limit';
      const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') parseError ??= error; } };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => { if (!closed) kill('SIGKILL'); }, opts.killGraceMs ?? 3000);
    };
    const abort = () => stop('cancelled');
    const finish = patch => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(killTimer); opts.signal?.removeEventListener('abort', abort);
      const subtype = timedOut ? 'timeout' : cancelled ? 'cancelled' : overflow ? 'output_limit' : parseError ? 'event_handler_failed' : result?.subtype || 'no_result';
      const ok = !!result && !result.isError && !timedOut && !cancelled && !overflow && !parseError && (patch.exitCode === undefined || patch.exitCode === 0);
      resolve({ ok, isError: !ok, subtype, text: result?.result ?? text, sessionId: result?.sessionId ?? sessionId,
        durationMs: result?.durationMs, numTurns: result?.numTurns, costUsd: result?.totalCostUsd,
        errors: parseError ? [parseError.message] : result?.errors, stderr, ...patch });
    };
    const line = raw => {
      if (closed || !raw.trim()) return;
      let event; try { event = JSON.parse(raw); } catch { return; }
      if (event.sessionId) sessionId = event.sessionId;
      try { opts.onEvent?.(event); } catch (error) { parseError = error; stop('event_error'); }
      if (event.type === 'text' && typeof event.text === 'string') { text += event.text; try { opts.onText?.(event.text); } catch (error) { parseError = error; stop('event_error'); } }
      if (event.type === 'result') result = event;
    };
    if (opts.signal?.aborted) { cancelled = true; finish({}); return; }
    try { child = spawn(opts.bin || resolveMetaAgentBin(), args, { cwd: opts.workspace, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' }); }
    catch (error) { finish({ ok: false, isError: true, subtype: 'spawn_failed', errors: [error.message] }); return; }
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (opts.timeoutMs > 0) timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > cap) { stop('output_limit'); return; }
      buffer += chunk;
      let end; while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once('error', error => finish({ ok: false, isError: true, subtype: 'spawn_failed', errors: [error.message] }));
    child.once('close', (code, signal) => { line(buffer); finish({ exitCode: code, signal }); });
  });
}
