/**
 * Out-of-band alerts for when WeChat itself cannot carry the message
 * (stale bot token, network outage, rejected strangers, undeliverable reminders).
 *
 * Channels reuse the runtime's `notify.channels` config (Feishu/Lark, Slack,
 * generic webhook) so they are configured once; IM_ALERT_WEBHOOK_URL is a
 * direct override. IM_ALERT_DESKTOP=true adds a macOS notification.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { log } from './util.mjs';
import { atomicWrite, readState } from './durable-store.mjs';

const TYPES = new Set(['feishu', 'lark', 'slack', 'webhook']);

function expand(value, env) {
  if (typeof value !== 'string') return { ok: true, value };
  const missing = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') { missing.push(name); return ''; }
    return env[name];
  });
  return missing.length ? { ok: false, missing } : { ok: true, value: out };
}

function guessType(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)feishu\.cn$/.test(host)) return 'feishu';
    if (/(^|\.)larksuite\.com$/.test(host)) return 'lark';
    if (host === 'hooks.slack.com') return 'slack';
  } catch { /* validated later */ }
  return 'webhook';
}

/** Candidate meta-agent config files, in the same precedence the runtime uses. */
export function alertConfigCandidates(env = process.env) {
  const home = path.resolve(env.META_AGENT_HOME?.trim() || path.join(os.homedir(), '.meta-agent'));
  return [env.IM_ALERT_CONFIG_FILE, env.META_AGENT_CONFIG_FILE, path.join(home, 'config.json'), path.join(home, 'glm_config.json')]
    .filter(Boolean).map(file => path.resolve(file));
}

/** Resolve the alert channel(s). Never throws; problems are reported in `issues`. */
export function resolveAlertChannels(env = process.env, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const channels = [], issues = [];
  const add = (name, raw) => {
    const type = raw.type || guessType(raw.url);
    if (!TYPES.has(type)) { issues.push(`${name}: 不支持的类型 ${type}`); return; }
    const url = expand(raw.url, env), secret = expand(raw.secret, env);
    const headers = {};
    for (const [key, value] of Object.entries(raw.headers || {})) {
      const expanded = expand(value, env);
      if (!expanded.ok) { issues.push(`${name}: 缺少环境变量 ${expanded.missing.join(', ')}`); return; }
      headers[key] = expanded.value;
    }
    if (!url.ok || !secret.ok) { issues.push(`${name}: 缺少环境变量 ${[...(url.missing || []), ...(secret.missing || [])].join(', ')}`); return; }
    try { if (!/^https?:$/.test(new URL(url.value).protocol)) throw new Error(); }
    catch { issues.push(`${name}: url 不是 http(s) 地址`); return; }
    channels.push({ name, type, url: url.value, ...(secret.value ? { secret: secret.value } : {}), headers });
  };
  if (env.IM_ALERT_WEBHOOK_URL?.trim()) {
    add('env', { type: env.IM_ALERT_WEBHOOK_TYPE?.trim() || undefined, url: env.IM_ALERT_WEBHOOK_URL.trim(), secret: env.IM_ALERT_WEBHOOK_SECRET?.trim() || undefined });
  } else if (env.IM_ALERT_CHANNEL?.trim() !== 'none') {
    for (const file of alertConfigCandidates(env)) {
      let parsed;
      try { parsed = JSON.parse(readFile(file)); } catch (error) { if (error.code !== 'ENOENT') issues.push(`${file}: 无法读取 notify 配置`); continue; }
      const notify = parsed?.notify;
      if (!notify?.channels || typeof notify.channels !== 'object') continue;
      const wanted = env.IM_ALERT_CHANNEL?.trim() || notify.default || Object.keys(notify.channels)[0];
      if (wanted && notify.channels[wanted]) add(wanted, notify.channels[wanted]);
      else issues.push(`${file}: 未找到告警通道 ${wanted || '(空)'}`);
      break;
    }
  }
  const desktop = env.IM_ALERT_DESKTOP === 'true' && process.platform === 'darwin';
  return { channels, desktop, issues };
}

/** Request body for one channel; Feishu signing matches the runtime notify tool. */
export function buildAlertPayload(channel, text, now = Date.now()) {
  if (channel.type === 'feishu' || channel.type === 'lark') {
    const body = { msg_type: 'text', content: { text } };
    if (channel.secret) {
      const timestamp = String(Math.floor(now / 1000));
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', `${timestamp}\n${channel.secret}`).update('').digest('base64');
    }
    return body;
  }
  return { text };
}

async function postChannel(channel, text, fetchFn) {
  const response = await fetchFn(channel.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...channel.headers },
    body: JSON.stringify(buildAlertPayload(channel, text)), signal: AbortSignal.timeout(15000),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (channel.type === 'feishu' || channel.type === 'lark') {
    let code; try { const reply = JSON.parse(body); code = reply.code ?? reply.StatusCode; } catch { return; }
    if (code !== undefined && code !== 0) throw new Error(`飞书拒绝：code ${code}`);
  }
  if (channel.type === 'slack' && body.trim() && body.trim() !== 'ok') throw new Error('Slack 拒绝');
}

function desktopNotify(text, spawnFn = spawn) {
  const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 900)}"`;
  const child = spawnFn('osascript', ['-e', `display notification ${quote(text)} with title "IM MetaAgent"`], { stdio: 'ignore' });
  child.on?.('error', () => {});
  child.unref?.();
}

export class AlertNotifier {
  /**
   * @param {object} opts
   * @param {string} [opts.stateFile] persisted per-key send times (dedupe across restarts)
   */
  constructor({ env = process.env, stateFile, fetchFn = globalThis.fetch, spawnFn = spawn, now = Date.now, channels } = {}) {
    const resolved = channels ? { channels, desktop: false, issues: [] } : resolveAlertChannels(env);
    this.channels = resolved.channels; this.desktop = resolved.desktop; this.issues = resolved.issues;
    this.fetchFn = fetchFn; this.spawnFn = spawnFn; this.now = now; this.stateFile = stateFile;
    this.queue = []; this.timer = null; this.flushing = null;
    this.sent = {};
    try { this.sent = (stateFile && readState(stateFile, {}).sent) || {}; } catch { this.sent = {}; }
    for (const issue of this.issues) log.warn(`告警通道配置问题：${issue}`);
  }
  get configured() { return this.channels.length > 0 || this.desktop; }
  describe() {
    if (!this.configured) return '未配置（在 meta-agent 配置的 notify.channels 中添加飞书/Slack/webhook，或设置 IM_ALERT_WEBHOOK_URL）';
    return [...this.channels.map(c => `${c.name}(${c.type})`), ...(this.desktop ? ['macOS 通知'] : [])].join(', ');
  }
  /**
   * Queue an alert. With `key`, the same key is sent at most once per `minIntervalMs`
   * (persisted). Returns false when suppressed or no channel is configured.
   */
  send(text, { key, minIntervalMs = 6 * 60 * 60 * 1000 } = {}) {
    if (!this.configured) { log.warn(`告警未发送（未配置通道）：${text.split('\n')[0]}`); return false; }
    const at = this.now();
    if (key && this.sent[key] && at - this.sent[key] < minIntervalMs) return false;
    if (key) { this.sent[key] = at; this.persist(); }
    const message = `【IM MetaAgent · ${os.hostname()}】\n${text}`;
    if (this.desktop) { try { desktopNotify(text, this.spawnFn); } catch { /* best effort */ } }
    if (this.channels.length) { this.queue.push({ message, attempts: 0, nextAt: at, firstAt: at }); void this.flush(); }
    return true;
  }
  /** Allow `key` to alert again immediately (e.g. after recovery). */
  reset(key) { if (this.sent[key]) { delete this.sent[key]; this.persist(); } }
  persist() {
    if (!this.stateFile) return;
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [key, at] of Object.entries(this.sent)) if (at < cutoff) delete this.sent[key];
    try { atomicWrite(this.stateFile, { sent: this.sent }); } catch (error) { log.warn('告警状态保存失败', { err: error.message }); }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const at = this.now();
      for (const item of [...this.queue]) {
        if (item.nextAt > at) continue;
        const failures = [];
        for (const channel of this.channels) {
          try { await postChannel(channel, item.message, this.fetchFn); }
          catch (error) { failures.push(`${channel.name}: ${error.message}`); }
        }
        if (failures.length < this.channels.length) { this.queue.splice(this.queue.indexOf(item), 1); continue; }
        item.attempts++;
        if (at - item.firstAt > 24 * 60 * 60 * 1000) { this.queue.splice(this.queue.indexOf(item), 1); log.error('告警发送放弃（超过 24 小时）', { failures }); continue; }
        item.nextAt = at + Math.min(15 * 60 * 1000, 30000 * 2 ** Math.min(item.attempts, 5));
        log.warn('告警发送失败，稍后重试', { failures });
      }
      while (this.queue.length > 50) this.queue.shift();
      clearTimeout(this.timer); this.timer = null;
      if (this.queue.length) {
        const wait = Math.max(1000, Math.min(...this.queue.map(item => item.nextAt)) - this.now());
        this.timer = setTimeout(() => void this.flush(), wait); this.timer.unref?.();
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  close() { clearTimeout(this.timer); this.timer = null; }
}

/**
 * Watches the bot's polling health and alerts on stale login and long outages,
 * then once more on recovery.
 */
export class ConnectionMonitor {
  constructor({ alerts, offlineAfterMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.alerts = alerts; this.offlineAfterMs = offlineAfterMs; this.now = now;
    this.failingSince = null; this.alerted = new Set();
  }
  attach(bot) {
    bot.on('session-expired', accountId => this.onExpired(accountId));
    bot.on('error', error => this.onError(error));
    bot.on('recovered', info => this.onRecovered(info));
    return this;
  }
  onExpired(accountId) {
    this.failingSince ??= this.now();
    this.alerted.add('expired');
    this.alerts.send(`微信登录已失效（账号 ${accountId}，errcode -14）。机器人已暂停收发消息，待发送的回复会保留。\n请在运行机器人的电脑上执行：npm run agent:login 重新扫码；登录后会自动恢复，无需重启。`,
      { key: `expired:${accountId}`, minIntervalMs: 6 * 60 * 60 * 1000 });
  }
  onError(error) {
    if (error?.errcode === -14 || error?.ret === -14) return;
    this.failingSince ??= this.now();
    const downMs = this.now() - this.failingSince;
    if (downMs < this.offlineAfterMs || this.alerted.has('offline')) return;
    this.alerted.add('offline');
    this.alerts.send(`微信消息轮询已连续失败 ${Math.round(downMs / 60000)} 分钟：${String(error?.message || error).slice(0, 200)}\n可能是网络/DNS 中断。恢复后会再通知。`,
      { key: 'offline', minIntervalMs: 60 * 60 * 1000 });
  }
  onRecovered(info = {}) {
    const wasAlerted = this.alerted.size > 0;
    const downMs = info.downMs ?? (this.failingSince ? this.now() - this.failingSince : 0);
    this.failingSince = null; this.alerted.clear();
    this.alerts.reset('offline');
    if (info.accountId) this.alerts.reset(`expired:${info.accountId}`);
    if (wasAlerted) this.alerts.send(`微信连接已恢复（中断约 ${Math.max(1, Math.round(downMs / 60000))} 分钟）。`);
  }
}
