/**
 * Durable reminders and scheduled chat prompts (pure helpers + talk tools).
 *
 * Times are the bot machine's local time (set TZ for the service if needed).
 * The talk worker only *proposes* operations; the bot process applies them to
 * its single-writer state when the turn's result arrives.
 */
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export const MAX_ACTIVE_SCHEDULES = 50;
const pad = n => String(n).padStart(2, '0');

function parseField(text, [min, max], index) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`无法解析 cron 字段：${part}`);
    let start = m[1] === '*' ? min : Number(m[1]);
    let end = m[1] === '*' ? max : m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? max : start;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (!(step >= 1) || start < min || end > max || start > end) throw new Error(`cron 字段超出范围：${part}`);
    for (let v = start; v <= end; v += step) values.add(index === 4 && v === 7 ? 0 : v);
  }
  return values;
}

/** Parse a standard 5-field cron (minute hour day-of-month month day-of-week). */
export function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 需要 5 个字段：分 时 日 月 周，例如 "0 8 * * *" 表示每天 08:00');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_RANGES[i], i));
  return { expr: fields.join(' '), minute, hour, dom, month, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

function dayMatches(cron, date) {
  const domOk = cron.dom.has(date.getDate()), dowOk = cron.dow.has(date.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk; // Vixie cron: restricted dom and dow are OR-ed.
}

/** Next local time strictly after `after` (ms) matching the cron, or null within ~366 days. */
export function nextCronTime(exprOrCron, after) {
  const cron = typeof exprOrCron === 'string' ? parseCron(exprOrCron) : exprOrCron;
  const d = new Date(after); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const limit = after + 367 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (!cron.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(cron, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!cron.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/** Parse a one-shot time: "YYYY-MM-DD HH:mm", ISO 8601 (with offset), or "HH:mm" (next occurrence). */
export function parseAt(text, now = Date.now()) {
  const raw = String(text || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0));
    const date = new Date(y, mo - 1, d, h, mi, s);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) throw new Error(`无效时间：${raw}`);
    return date.getTime();
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (m) {
    const [h, mi] = m.slice(1).map(Number);
    if (h > 23 || mi > 59) throw new Error(`无效时间：${raw}`);
    const date = new Date(now); date.setHours(h, mi, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const value = Date.parse(raw);
    if (Number.isFinite(value)) return value;
  }
  throw new Error(`无法解析时间“${raw}”，请用 "YYYY-MM-DD HH:mm"（本机时区）`);
}

export function formatLocal(ms, now = Date.now()) {
  const d = new Date(ms), today = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}-`}${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${WEEKDAYS[d.getDay()]} ${time}`;
}

/** Full local timestamp with weekday and UTC offset, for model context. */
export function formatNow(ms = Date.now()) {
  const d = new Date(ms), offset = -d.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}（UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}）`;
}

/** Human-readable repetition for common cron shapes; falls back to the raw expression. */
export function describeCron(expr) {
  const [mi, h, dom, mon, dow] = String(expr).split(/\s+/);
  const simple = /^\d+$/.test(mi) && /^\d+$/.test(h);
  const time = simple ? `${pad(h)}:${pad(mi)}` : null;
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `每天 ${time}`;
    if (dow === '1-5') return `工作日 ${time}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) return `每周${dow.split(',').map(v => WEEKDAYS[Number(v) % 7]).join('、')} ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `每月 ${dom} 日 ${time}`;
  return `cron "${expr}"`;
}

export function describeSchedule(schedule, now = Date.now()) {
  const when = schedule.cron ? `${describeCron(schedule.cron)}（下次 ${schedule.nextAt ? formatLocal(schedule.nextAt, now) : '无'}）` : formatLocal(schedule.at ?? schedule.nextAt, now);
  const kind = schedule.kind === 'talk' ? '定时执行' : '提醒';
  return `${schedule.id ? `${schedule.id} · ` : ''}${kind} · ${when} · ${String(schedule.text).slice(0, 120)}`;
}

/**
 * Validate a create request and compute its first fire time. Throws a
 * user-facing message on invalid input.
 */
export function planSchedule({ text, at, cron, kind = 'remind' }, now = Date.now()) {
  const body = String(text || '').trim();
  if (!body) throw new Error('需要提醒内容 text');
  if (body.length > 2000) throw new Error('内容过长（最多 2000 字）');
  if (!['remind', 'talk'].includes(kind)) throw new Error('kind 只能是 remind（到点发提醒）或 talk（到点执行一段聊天指令并发结果）');
  if (Boolean(at) === Boolean(cron)) throw new Error('at（一次性）和 cron（重复）必须二选一');
  if (at) {
    const fireAt = parseAt(at, now);
    if (fireAt <= now + 30 * 1000) throw new Error(`时间 ${formatLocal(fireAt, now)} 已过去或太近`);
    if (fireAt > now + 366 * 24 * 60 * 60 * 1000) throw new Error('只支持一年内的提醒');
    return { kind, text: body, at: fireAt, nextAt: fireAt };
  }
  const parsed = parseCron(cron);
  if (parsed.minute.size > 12 && parsed.hour.size > 1) throw new Error('重复频率过高（同一小时内最多 12 次），请降低频率');
  const nextAt = nextCronTime(parsed, now);
  if (!nextAt) throw new Error('该 cron 在一年内不会触发');
  return { kind, text: body, cron: parsed.expr, nextAt };
}

/** Next fire time after a run at `firedAt`, or null for one-shot schedules. */
export function advanceSchedule(schedule, firedAt) {
  return schedule.cron ? nextCronTime(schedule.cron, firedAt) : null;
}

/**
 * Talk-session tools. `existing` is the owner's active schedules snapshot;
 * accepted operations are pushed to `ops` and applied by the bot process.
 */
export function createScheduleTools({ existing = [], ops = [], now = Date.now } = {}) {
  const permission = { category: 'state', requiresWorkspace: false, sensitive: false, planMode: 'allow' };
  const pendingCreates = () => ops.filter(op => op.type === 'create').length;
  return [{
    name: 'reminder_create',
    abortSupport: 'bounded',
    permission,
    description: '为用户创建提醒或定时任务，由微信机器人在到点时发送。一次性用 at（本机时间 "YYYY-MM-DD HH:mm"），重复用 cron（5 字段：分 时 日 月 周，如 "0 8 * * 1-5" 为工作日 08:00）。'
      + 'kind=remind 到点原样发送 text；kind=talk 到点把 text 当作一条聊天指令执行（可联网搜索），把结果发给用户，适合“每天早上给我简报”。'
      + '只有用户明确要求提醒/定时时才调用；时间不明确先问用户。调用成功只代表已提交，机器人会在本条回复后发确认。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', description: '到点发送的提醒内容，或 kind=talk 时要执行的指令' },
      at: { type: 'string', description: '一次性时间，本机时区 "YYYY-MM-DD HH:mm"' },
      cron: { type: 'string', description: '重复规则，5 字段 cron' },
      kind: { type: 'string', enum: ['remind', 'talk'], description: '默认 remind' },
    } },
    async call(input) {
      try {
        if (existing.length + pendingCreates() >= MAX_ACTIVE_SCHEDULES) throw new Error(`最多 ${MAX_ACTIVE_SCHEDULES} 个有效提醒，请先取消一些`);
        const plan = planSchedule(input, now());
        ops.push({ type: 'create', ...plan });
        return { content: `已提交：${describeSchedule(plan, now())}。编号会在机器人确认消息中给出。`, isError: false };
      } catch (error) { return { content: `未创建：${error.message}`, isError: true }; }
    },
  }, {
    name: 'reminder_list',
    abortSupport: 'bounded',
    permission: { ...permission, category: 'read' },
    description: '列出用户当前有效的提醒和定时任务（编号 R1、R2…）。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async call() {
      return { content: existing.length ? existing.map(s => describeSchedule(s, now())).join('\n') : '当前没有有效的提醒或定时任务。', isError: false };
    },
  }, {
    name: 'reminder_cancel',
    abortSupport: 'bounded',
    permission,
    description: '按编号取消用户的提醒或定时任务（如 R3）。只在用户明确要求取消时调用。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: '提醒编号，如 R3' } } },
    async call(input) {
      const id = String(input.id || '').trim().toUpperCase();
      if (!existing.some(s => s.id === id)) return { content: `没有有效的提醒 ${id}`, isError: true };
      ops.push({ type: 'cancel', id });
      return { content: `已提交取消 ${id}。`, isError: false };
    },
  }];
}
