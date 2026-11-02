/**
 * Client and supervisor for `meta-agent serve` (runtime ≥ 0.14): one resident
 * simple_auto process for every chat turn, so a message no longer pays for a
 * process start, config/tool loading and history replay.
 *
 * Protocol: docs/参考手册/serve常驻会话.md in the runtime repository.
 *  - turn → accepted → event* → turn_end (exactly one per accepted turn)
 *  - tool_call → (host runs the tool) → tool_result
 *  - ping → pong (health)
 * The process is restarted on exit or when it stops answering pings; turns in
 * flight then end with subtype `serve_crashed`. After too many restarts in a
 * short window the host disables itself and callers fall back to one-shot CLI.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

export const SERVE_USAGE_PREFIX = 'Usage: meta-agent serve';

/** True when `bin serve --help` prints the serve usage (older runtimes print the generic help). */
export function probeServe(bin, { env = process.env, timeoutMs = 15000, spawnImpl = nodeSpawn } = {}) {
  return new Promise(resolve => {
    let out = '', child, done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } finish(false); }, timeoutMs);
    try { child = spawnImpl(bin, ['serve', '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(false); return; }
    child.stdout?.on('data', data => { if (out.length < 4096) out += data; });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && out.trimStart().startsWith(SERVE_USAGE_PREFIX)));
  });
}

export class TalkHost {
  constructor({ bin, args = [], env = process.env, onToolCall, log = console, spawnImpl = nodeSpawn,
    readyTimeoutMs = 90000, pingIntervalMs = 30000, pingTimeoutMs = 15000, maxRestarts = 5, restartWindowMs = 10 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { bin, args, env, onToolCall, log, spawnImpl, readyTimeoutMs, pingIntervalMs, pingTimeoutMs, maxRestarts, restartWindowMs, now });
    this.child = null; this.ready = false; this.starting = null; this.closing = false; this.disabled = false;
    this.pending = new Map(); this.toolCalls = new Map(); this.restarts = []; this.info = null;
    this.lastPong = 0; this.pingSeq = 0; this.timer = null; this.stderrTail = '';
  }
  /** Usable now or after a restart. False once the restart budget is spent or the host is closed. */
  get available() { return !this.disabled && !this.closing; }
  start() {
    this.timer ??= setInterval(() => this.healthCheck(), this.pingIntervalMs);
    this.timer.unref?.();
    return this.ensure();
  }
  ensure() {
    if (!this.available) return Promise.reject(new Error('常驻助手进程不可用'));
    if (this.child && this.ready) return Promise.resolve(this.info);
    this.starting ??= this.spawnProcess().finally(() => { this.starting = null; });
    return this.starting;
  }
  spawnProcess() {
    return new Promise((resolve, reject) => {
      let child, settled = false;
      const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => {
        settle(reject, new Error(`常驻助手 ${Math.round(this.readyTimeoutMs / 1000)} 秒内未就绪`));
        try { child?.kill('SIGKILL'); } catch { /* gone */ }
      }, this.readyTimeoutMs);
      try { child = this.spawnImpl(this.bin, ['serve', ...this.args], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { this.noteExit(error.message); settle(reject, error); return; }
      this.child = child; this.ready = false; this.lastPong = this.now();
      child.stdin.on('error', () => { /* exit handler reports */ });
      child.stderr?.on('data', data => { this.stderrTail = (this.stderrTail + data).slice(-4000); });
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let message; try { message = JSON.parse(line); } catch { this.log.warn?.(`常驻助手输出了非协议内容：${line.slice(0, 200)}`); return; }
        if (message.type === 'ready') {
          this.ready = true; this.info = message; this.lastPong = this.now();
          this.log.info?.(`常驻助手已就绪：meta-agent ${message.version}（protocol ${message.protocol}，pid ${message.pid}）`);
          settle(resolve, message); return;
        }
        if (message.type === 'fatal') { this.log.error?.(`常驻助手启动失败：${message.error?.message || ''}`); this.disabled = true; settle(reject, new Error(message.error?.message || 'fatal')); return; }
        this.handle(message);
      });
      child.once('error', error => { this.log.warn?.(`常驻助手进程错误：${error.message}`); });
      child.once('exit', (code, signal) => {
        if (this.child === child) { this.child = null; this.ready = false; }
        const reason = `退出码 ${code ?? signal}`;
        this.failPending('serve_crashed', `常驻助手进程已退出（${reason}）`);
        if (!this.closing) this.noteExit(`${reason}${this.stderrTail ? `；stderr：${this.stderrTail.slice(-500)}` : ''}`);
        settle(reject, new Error(`常驻助手进程退出（${reason}）`));
      });
    });
  }
  noteExit(reason) {
    const now = this.now();
    this.restarts = this.restarts.filter(at => now - at < this.restartWindowMs);
    this.restarts.push(now);
    if (this.restarts.length > this.maxRestarts) {
      this.disabled = true;
      this.log.error?.(`常驻助手 ${Math.round(this.restartWindowMs / 60000)} 分钟内异常退出 ${this.restarts.length} 次，已停用并改用单次运行：${reason}`);
    } else this.log.warn?.(`常驻助手异常退出，将在下一条消息时重启：${reason}`);
  }
  send(message) {
    if (!this.child?.stdin?.writable) throw new Error('常驻助手进程未运行');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  handle(message) {
    const pending = message.id ? this.pending.get(message.id) : undefined;
    switch (message.type) {
      case 'accepted': if (pending) pending.acceptedAt = this.now(); return;
      case 'event':
        if (pending) {
          pending.firstEventAt ??= this.now();
          try { pending.onEvent?.(message.event); } catch (error) { this.log.warn?.(`事件处理失败：${error.message}`); }
        }
        return;
      case 'tool_call': void this.runTool(message); return;
      case 'tool_cancel': this.toolCalls.get(message.callId)?.abort(); this.toolCalls.delete(message.callId); return;
      case 'turn_end':
        if (pending) { this.pending.delete(message.id); pending.resolve({ ...message, timing: this.timing(pending) }); }
        return;
      case 'pong': this.lastPong = this.now(); return;
      case 'error':
        if (pending) { this.pending.delete(message.id); pending.resolve({ id: message.id, ok: false, subtype: 'error', error: message.error, timing: this.timing(pending) }); }
        else this.log.warn?.(`常驻助手报告错误：${message.error?.message || JSON.stringify(message)}`);
        return;
      default: return;
    }
  }
  timing(pending) {
    return { queuedMs: pending.acceptedAt ? pending.acceptedAt - pending.sentAt : null,
      firstEventMs: pending.firstEventAt ? pending.firstEventAt - pending.sentAt : null, totalMs: this.now() - pending.sentAt };
  }
  async runTool(message) {
    const controller = new AbortController();
    this.toolCalls.set(message.callId, controller);
    let result;
    try {
      result = await this.onToolCall(message.name, message.input || {}, { turnId: message.id, sessionId: message.sessionId, workspace: message.workspace, signal: controller.signal });
    } catch (error) { result = { content: error.message, isError: true }; }
    if (!this.toolCalls.delete(message.callId)) return; // cancelled meanwhile; the answer is not wanted
    const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '');
    try { this.send({ type: 'tool_result', callId: message.callId, content, isError: result?.isError === true }); }
    catch (error) { this.log.warn?.(`工具结果未送达：${error.message}`); }
  }
  /**
   * Run one turn. Always resolves (never rejects) with a turn_end-shaped
   * object, so callers can settle their durable record either way.
   */
  async turn(request, { onEvent } = {}) {
    const sentAt = this.now();
    try { await this.ensure(); }
    catch (error) { return { id: request.id, ok: false, subtype: 'serve_unavailable', error: { code: 'SERVE_UNAVAILABLE', message: error.message }, timing: { totalMs: this.now() - sentAt } }; }
    return new Promise(resolve => {
      this.pending.set(request.id, { resolve, onEvent, sentAt });
      try { this.send({ type: 'turn', stream: Boolean(onEvent), ...request }); }
      catch (error) { this.pending.delete(request.id); resolve({ id: request.id, ok: false, subtype: 'serve_unavailable', error: { code: 'SERVE_UNAVAILABLE', message: error.message }, timing: { totalMs: 0 } }); }
    });
  }
  interrupt(id) { try { this.send({ type: 'interrupt', id }); } catch { /* not running: nothing to stop */ } }
  isRunning(id) { return this.pending.has(id); }
  failPending(subtype, message) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve({ id, ok: false, subtype, error: { code: subtype.toUpperCase(), message }, timing: this.timing(pending) });
    }
    for (const controller of this.toolCalls.values()) controller.abort();
    this.toolCalls.clear();
  }
  healthCheck() {
    if (!this.child || !this.ready || this.closing) return;
    if (this.now() - this.lastPong > this.pingIntervalMs + this.pingTimeoutMs) {
      this.log.warn?.('常驻助手无响应，正在重启');
      try { this.child.kill('SIGKILL'); } catch { /* gone */ }
      return;
    }
    try { this.send({ type: 'ping', id: `ping-${++this.pingSeq}` }); } catch { /* exit handler restarts */ }
  }
  async close({ graceMs = 8000 } = {}) {
    this.closing = true;
    clearInterval(this.timer); this.timer = null;
    const child = this.child;
    if (!child) return;
    const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
    try { this.send({ type: 'shutdown' }); } catch { /* already closing */ }
    let timer;
    const timedOut = await Promise.race([exited.then(() => false), new Promise(r => { timer = setTimeout(() => r(true), graceMs); })]);
    clearTimeout(timer);
    if (timedOut) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    this.failPending('cancelled', 'IM 正在停止');
  }
}
