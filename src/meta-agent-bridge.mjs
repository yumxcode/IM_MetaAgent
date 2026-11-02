/** CLI transport. Every logical task owns its lifecycle and configuration. */
import { spawn } from 'node:child_process';
import { resolveRuntimeCli } from './runtime-cli.mjs';

/** The executable every route uses (META_AGENT_CLI / META_AGENT_RUNTIME_DIR / META_AGENT_BIN). */
export const resolveMetaAgentBin = (env = process.env) => resolveRuntimeCli(env).bin;

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
  const { mode = 'auto', maxTurns, workspace, sessionDir, resumeSessionId, intent = 'new', images = [] } = opts;
  if (!['new', 'continue', 'steer', 'new_goal'].includes(intent)) throw new Error('Unknown execution intent');
  if (intent !== 'new' && !resumeSessionId) throw new Error('Continuation requires a session ID');
  if (intent === 'new' && resumeSessionId) throw new Error('A new task must not resume another task');
  if (intent !== 'continue' && !String(prompt || '').trim()) throw new Error('empty prompt');
  // Limits are passed only when the operator configured them; otherwise meta-agent's own defaults apply.
  const args = ['--json', '--yes', '--mode', mode];
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(Math.floor(maxTurns)));
  if (workspace) args.push('--workspace', workspace);
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (opts.systemPrompt) args.push('--system', opts.systemPrompt);
  if (Number.isFinite(opts.maxBudgetUsd) && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  for (const image of images) args.push('--image', image);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (intent === 'continue') args.push('--continue');
  else if (intent === 'steer') args.push('--steer', prompt);
  else if (intent === 'new_goal') args.push('--new-goal', prompt);
  else args.push('--', prompt); // Model text can never become CLI options.
  return args;
}

/**
 * Stream bounds. The bridge keeps only the current partial line and a tail of
 * streamed text, so the TOTAL stream size needs no cap: a long Auto task can
 * legitimately print many megabytes, and the old 4 MiB cumulative cap killed
 * such runs mid-task (reported as "output_limit"). Instead a single oversized
 * line is skipped (never the run), and the text fallback keeps its tail.
 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_CHARS = 64 * 1024;

/**
 * Ask the runtime for lean JSON events (≥ 0.14.2): thinking deltas and tool
 * payloads are omitted, ids/names/status/result kept — everything the IM reads.
 * An env var, not a flag, so older runtimes simply ignore it. An operator value wins.
 */
export function metaAgentEnv(base = process.env) {
  return base.META_AGENT_JSON_EVENTS ? base : { ...base, META_AGENT_JSON_EVENTS: 'lean' };
}

const SUBTYPE_TEXT = {
  success: '已完成',
  partial: '部分完成',
  parked: '已挂起，等待定时唤醒',
  error_max_turns: '达到最大轮数上限',
  error_max_budget: '达到预算上限',
  error_max_output_tokens: '模型单次输出达到 token 上限',
  error_during_execution: '执行过程中出错',
  timeout: '超过 IM 配置的执行时限，进程已被终止',
  cancelled: '已取消',
  no_result: '进程退出但没有返回结果事件（可能崩溃或被外部终止）',
  event_handler_failed: 'IM 处理执行事件时出错，进程已被终止',
  spawn_failed: '无法启动 meta-agent',
  invalid_input: '请求参数无效',
  output_limit: '旧版 IM 的输出流累计字节上限（4MB）触发，进程被 IM 终止；与模型输出长度无关，可直接续跑',
};
/** "subtype（中文说明）" for user-facing status lines; unknown subtypes are shown as-is. */
export function describeRunSubtype(subtype) {
  const text = SUBTYPE_TEXT[subtype];
  return text ? `${subtype}（${text}）` : String(subtype ?? '');
}

export async function runMetaAgent(prompt, opts = {}) {
  let args;
  try { args = buildMetaAgentArgs(prompt, opts); }
  catch (error) { return { ok: false, isError: true, subtype: 'invalid_input', text: '', errors: [error.message] }; }
  return new Promise(resolve => {
    let child, buffer = '', stderr = '', text = '', result, sessionId, timer, killTimer;
    let closed = false, timedOut = false, cancelled = false, parseError;
    const maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const maxText = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    let skipping = false, droppedLines = 0, bufferBytes = 0;
    const stop = reason => {
      if (closed || !child) return;
      timedOut ||= reason === 'timeout'; cancelled ||= reason === 'cancelled';
      const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') parseError ??= error; } };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => { if (!closed) kill('SIGKILL'); }, opts.killGraceMs ?? 3000);
    };
    const abort = () => stop('cancelled');
    const finish = patch => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(killTimer); opts.signal?.removeEventListener('abort', abort);
      const subtype = timedOut ? 'timeout' : cancelled ? 'cancelled' : parseError ? 'event_handler_failed' : result?.subtype || 'no_result';
      const ok = !!result && !result.isError && !timedOut && !cancelled && !parseError && (patch.exitCode === undefined || patch.exitCode === 0);
      const dropped = droppedLines ? [`跳过了 ${droppedLines} 条超过 ${maxLine} 字节的事件行`] : [];
      const errors = parseError ? [parseError.message] : result?.errors;
      resolve({ ok, isError: !ok, subtype, text: result?.result ?? text, sessionId: result?.sessionId ?? sessionId,
        durationMs: result?.durationMs, numTurns: result?.numTurns, costUsd: result?.totalCostUsd,
        errors: dropped.length && !result ? [...(errors || []), ...dropped] : errors, stderr,
        ...(droppedLines ? { droppedLines } : {}), ...patch });
    };
    const line = raw => {
      if (closed || !raw.trim()) return;
      let event; try { event = JSON.parse(raw); } catch { return; }
      if (event.sessionId) sessionId = event.sessionId;
      try { opts.onEvent?.(event); } catch (error) { parseError = error; stop('event_error'); }
      if (event.type === 'text' && typeof event.text === 'string') { text += event.text; if (text.length > maxText * 2) text = text.slice(-maxText); try { opts.onText?.(event.text); } catch (error) { parseError = error; stop('event_error'); } }
      if (event.type === 'result') result = event;
    };
    if (opts.signal?.aborted) { cancelled = true; finish({}); return; }
    try { child = spawn(opts.bin || resolveMetaAgentBin(), args, { cwd: opts.workspace, env: metaAgentEnv(opts.env || process.env), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' }); }
    catch (error) { finish({ ok: false, isError: true, subtype: 'spawn_failed', errors: [error.message] }); return; }
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (opts.timeoutMs > 0) timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      // Lines are processed as they complete; an oversized line is discarded
      // up to its newline instead of growing the buffer or killing the run.
      let start = 0, end;
      while ((end = chunk.indexOf('\n', start)) >= 0) {
        const piece = chunk.slice(start, end); start = end + 1;
        if (skipping) { skipping = false; continue; }
        const size = bufferBytes + Buffer.byteLength(piece), full = buffer + piece;
        buffer = ''; bufferBytes = 0;
        if (size > maxLine) { droppedLines++; continue; }
        line(full);
      }
      if (start < chunk.length && !skipping) {
        const rest = chunk.slice(start);
        buffer += rest; bufferBytes += Buffer.byteLength(rest);
        if (bufferBytes > maxLine) { droppedLines++; buffer = ''; bufferBytes = 0; skipping = true; }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once('error', error => finish({ ok: false, isError: true, subtype: 'spawn_failed', errors: [error.message] }));
    child.once('close', (code, signal) => { if (!skipping) line(buffer); finish({ exitCode: code, signal }); });
  });
}
