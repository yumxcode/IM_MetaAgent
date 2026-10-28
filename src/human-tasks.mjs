import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeJson } from './util.mjs';
import { createHumanTaskApi } from './human-task-api.mjs';

const OPEN = new Set(['pending', 'delivered', 'acked']);
const keyOf = (accountId, userId) => JSON.stringify([accountId, userId]);
const same = (a, b) => a?.accountId === b?.accountId && a?.userId === b?.userId;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const ref = taskId => ({ taskId });
const HELP = '先单独发送 /human 进入人工回填模式，再直接发送：\nhelp：我的待办\nwhoami：查看当前微信身份\nH1：选择工单并恢复草稿（已结束工单仅查看）\nH1 填写：开始回填\nH1 接单、H1 拒绝 原因\n逐项回复字段值，最后发送 提交；退出填写 保留草稿。\n单独发送 human/ 退出人工回填模式。';

function completionMatches(task, input) {
  const receipt = task.receipt, by = receipt?.completedBy;
  return task.status === 'done' && receipt?.attestation === 'human_relayed' &&
    by?.actor === input.actor && by.channel === input.channel && by.messageId === input.messageId && by.relayedBy === input.relayedBy &&
    isDeepStrictEqual(receipt.outputs, input.outputs) && (receipt.rawText || '') === (input.rawText || '');
}

function readState(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** A personal inbox for every project, using the selected bot unless overridden. */
export function loadHumanDefaultRecipient(env = process.env, defaultAccountId) {
  const userId = env.META_AGENT_HUMAN_DEFAULT_USER_ID?.trim();
  const configuredAccount = env.META_AGENT_HUMAN_DEFAULT_ACCOUNT_ID?.trim();
  if (!userId) {
    if (configuredAccount) throw new Error('设置 META_AGENT_HUMAN_DEFAULT_ACCOUNT_ID 时也需要 META_AGENT_HUMAN_DEFAULT_USER_ID');
    return null;
  }
  const accountId = configuredAccount || env.WEIXIN_ACCOUNT_ID?.trim() || defaultAccountId;
  if (!accountId) throw new Error('人工工单默认收件人缺少机器人账号；请先登录或设置 META_AGENT_HUMAN_DEFAULT_ACCOUNT_ID');
  return { accountId, userId };
}

/** One explicitly configured recipient per workspace/role; no model-selected IDs. */
export function loadHumanRoutes(file) {
  if (!file) return [];
  const config = readState(file, null);
  if (!config || !Array.isArray(config.routes)) throw new Error('人工工单路由文件需要 routes 数组');
  const seen = new Set();
  return config.routes.map(route => {
    if (!path.isAbsolute(route.workspace || '') || !route.accountId || !route.userId ||
        (route.role !== undefined && typeof route.role !== 'string')) throw new Error('工单路由需要 workspace 绝对路径、accountId、userId 和可选 role');
    const normalized = { ...route, workspace: path.resolve(route.workspace) };
    const id = JSON.stringify([normalized.workspace, normalized.role || '']);
    if (seen.has(id)) throw new Error('人工工单路由中项目/角色重复');
    seen.add(id);
    return normalized;
  });
}

export function renderHumanTask(task, alias) {
  return [
    `【Agent 给你分配了任务】${task.title}`, `工单：${alias} (${task.taskId})`,
    `项目：${path.basename(task.workspace)} · 优先级：${({ urgent: '紧急', high: '高', normal: '普通' })[task.priority] || task.priority}`,
    task.assigneeRole && `角色：${task.assigneeRole}`, task.why && `原因：${task.why}`,
    ...(task.steps || []).map((step, i) => `${i + 1}. ${step}`),
    task.safety?.length && `安全事项：\n${task.safety.join('\n')}`,
    task.acceptance && `验收：${task.acceptance}`,
    `需要回填：${(task.requiredOutputs || []).map(o => `${o.name}(${o.type}${o.required ? '，必填' : ''})`).join('、') || '完成确认'}`,
    `有效至：${new Date(task.deadlineAt).toLocaleString('zh-CN', { hour12: false })} · 等待方式：${task.waitMode}`,
    task.waitMode === 'fallback' && `备用路径：${task.fallbackPlan || ''}（等待超时不等于工单过期）`,
    task.onComplete && `收到回执后：${task.onComplete}`,
    `请先退出当前模式（如有），再单独发送 /human。\n进入人工回填模式后发送：${alias} 接单、${alias} 填写、${alias} 拒绝 <原因>。`,
  ].filter(Boolean).join('\n');
}

export function parseHumanValue(field, text) {
  if (!text) throw new Error('请填写内容');
  if (field.type === 'bool') {
    if (/^(true|是|yes|1)$/i.test(text)) return true;
    if (/^(false|否|no|0)$/i.test(text)) return false;
    throw new Error('请回复 是 / 否');
  }
  if (field.type === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n) || (field.min != null && n < field.min) || (field.max != null && n > field.max)) throw new Error(`请填写有效数字（范围 ${field.min ?? '不限'} 至 ${field.max ?? '不限'}）`);
    return n;
  }
  if (field.type === 'enum' && !field.options?.includes(text)) throw new Error(`请选择：${field.options?.join(' / ')}`);
  return text;
}

/** Durable single consumer. Queue task operations; ordinary chat never waits on it. */
export function createHumanTasks({ bot, stateDir, routes = [], defaultRecipient = null, api = createHumanTaskApi(), allowFrom = [],
  pollMs = 5000, now = Date.now, log = console } = {}) {
  if (defaultRecipient && (!defaultRecipient.accountId || !defaultRecipient.userId)) throw new Error('人工工单默认收件人需要 accountId 和 userId');
  if (defaultRecipient && allowFrom.length && !allowFrom.includes(defaultRecipient.userId)) throw new Error('人工工单默认收件人不在 WEIXIN_ALLOW_FROM 白名单');
  const file = path.join(stateDir, 'human-tasks.json');
  const state = readState(file, { version: 1, cursor: 0, nextAlias: 1, tasks: {}, contacts: {}, origins: {}, drafts: {}, active: {}, replies: {} });
  if (state.version !== 1) throw new Error('不支持的人工工单状态版本');
  state.completedMessages ??= {};
  let tail = Promise.resolve(), timer, stopped = false, lastScan = 0, lockPath;
  const persist = () => writeJson(file, state);
  const serial = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const allowed = userId => !allowFrom.length || allowFrom.includes(userId);
  const automatic = !defaultRecipient && !routes.length;
  // Upgrade an existing single-user installation without requiring another
  // message. Ambiguous history is left for the next eligible private message.
  if (automatic && !state.autoRecipient) {
    const accountId = bot?.getDefaultAccount?.();
    const contacts = Object.entries(state.contacts).flatMap(([key, contact]) => {
      const [contactAccountId, userId] = JSON.parse(key);
      return contact.token && allowed(userId) && (!accountId || contactAccountId === accountId)
        ? [{ accountId: contactAccountId, userId }] : [];
    });
    // The poller persists this after taking its consumer lock. A read-only
    // --human-check must not overwrite a running consumer's state file.
    if (contacts.length === 1) state.autoRecipient = contacts[0];
  }
  const recipient = task => {
    const candidates = routes.filter(r => r.workspace === path.resolve(task.workspace));
    const route = (task.assigneeRole && candidates.find(r => r.role === task.assigneeRole)) || candidates.find(r => !r.role) || defaultRecipient ||
      (automatic && state.autoRecipient) ||
      (!task.assigneeRole && state.origins[JSON.stringify([task.workspace, task.sessionId])]);
    return route && allowed(route.userId) ? { accountId: route.accountId, userId: route.userId } : null;
  };
  const entry = taskId => state.tasks[taskId] ??= { alias: `H${state.nextAlias++}`, attempts: 0, retryAt: 0, dirty: true };
  const aliasId = alias => /^ht-[0-9a-f]{16}$/.test(alias) ? alias : Object.keys(state.tasks).find(id => state.tasks[id].alias.toLowerCase() === alias.toLowerCase());
  const inspect = async taskId => (await api('human_task.inspect', { task: ref(taskId) })).data;
  const send = async (route, text) => {
    if (!allowed(route.userId)) throw new Error('接收人不在 WEIXIN_ALLOW_FROM 白名单');
    const contact = state.contacts[keyOf(route.accountId, route.userId)];
    if (!contact?.token) throw new Error('等待接收人先发一条微信消息以建立会话');
    let result;
    // Keep every part, including safety notes; never silently truncate a task.
    const parts = text.match(/[\s\S]{1,1800}/g) || [''];
    for (let i = 0; i < parts.length; i++) result = await bot.sendText({ accountId: route.accountId, to: route.userId,
      contextToken: contact.token, text: parts.length > 1 ? `(${i + 1}/${parts.length}) ${parts[i]}` : parts[i] });
    return result;
  };
  const deliver = async taskId => {
    const e = entry(taskId);
    if (e.retryAt > now()) return;
    try {
      const { task } = await inspect(taskId);
      e.status = task.status;
      if (!OPEN.has(task.status)) {
        if (e.route && e.sent && !e.terminalSent && ['cancelled', 'expired'].includes(task.status)) {
          await send(e.route, `工单 ${e.alias} ${task.title} 已${task.status === 'cancelled' ? '取消' : '过期'}，无需继续执行。`);
          e.terminalSent = true;
        }
        e.finished = true; persist(); return;
      }
      const route = e.route || recipient(task);
      if (!route) throw new Error(automatic ? '等待你先私聊机器人，自动绑定工单收件人' : `待路由：${task.workspace} / ${task.assigneeRole || '默认负责人'}`);
      if (!allowed(route.userId)) throw new Error('接收人不在 WEIXIN_ALLOW_FROM 白名单');
      const prior = task.deliveries?.find(d => d.channel === 'weixin' && d.by === `im-metaagent:${route.accountId}` && d.recipient === route.userId);
      if (prior) { e.route = route; e.sent = true; e.registered = true; e.dirty = false; persist(); return; }
      if (!e.sent) {
        const result = await send(route, renderHumanTask(task, e.alias));
        e.route = route; e.sent = true;
        e.deliveryInput = { task: ref(taskId), channel: 'weixin', recipient: route.userId, by: `im-metaagent:${route.accountId}`,
          messageId: String(result.serverMessageId || result.messageId), requestId: `wx-deliver-${hash(`${taskId}:${keyOf(route.accountId, route.userId)}`)}` };
        persist(); // Retry registration, never resend after this point.
      }
      await api('human_task.deliver', e.deliveryInput);
      e.registered = true; e.dirty = false; e.attempts = 0; delete e.error; persist();
    } catch (error) {
      e.error = error.message; e.attempts++;
      e.retryAt = now() + Math.min(300_000, 5000 * 2 ** Math.min(e.attempts - 1, 6));
      persist(); log.warn(`人工工单 ${e.alias}: ${error.message}`);
    }
  };
  const tick = () => serial(async () => {
    if (stopped) return;
    const events = (await api('human_task.events', { all: true, cursor: state.cursor, limit: 100 })).data;
    for (const event of events.events) { const e = entry(event.taskId); e.retryAt = 0; e.dirty = true; }
    state.cursor = events.nextCursor;
    persist(); // Events are durably queued before the cursor advances on disk.
    if (!lastScan || now() - lastScan >= 60_000) {
      let cursor = 0;
      do {
        const response = await api('human_task.list', { all: true, open: true, limit: 100, cursor });
        for (const task of response.data.tasks) entry(task.taskId).dirty = true;
        cursor = response.page?.cursor ?? null;
      } while (cursor != null);
      lastScan = now(); persist();
    }
    let processed = 0;
    for (const [taskId, e] of Object.entries(state.tasks)) {
      if (stopped) break;
      if (!e.finished && (!e.registered || e.dirty) && e.retryAt <= now()) {
        await deliver(taskId);
        if (++processed >= 10) break;
      }
    }
  });
  const authorizedTask = async (taskId, route) => {
    if (!taskId) throw new Error('工单不存在或你无权访问');
    const detail = await inspect(taskId);
    if (!same(state.tasks[taskId]?.route || recipient(detail.task), route)) throw new Error('工单不存在或你无权访问');
    return detail;
  };
  const draftKey = (route, taskId) => JSON.stringify([route.accountId, route.userId, taskId]);
  const promptField = (task, draft) => {
    const field = (task.requiredOutputs || [])[draft.index];
    if (!field) return `回执摘要 ${entry(task.taskId).alias}：\n${JSON.stringify(draft.outputs, null, 2)}\n附件：${draft.attachments.map(a => `${a.field}: ${path.basename(a.path)}`).join('、') || '无'}\n回复“提交”正式回填；“重填”重新填写；“退出填写”保留草稿。`;
    return `填写 ${entry(task.taskId).alias} · ${field.name} (${field.type}${field.required ? '，必填' : '，可回复“跳过”'})\n${field.description || ''}${field.options ? `\n选项：${field.options.join(' / ')}` : ''}${field.accept ? `\n文件格式：${field.accept.join(' / ')}` : ''}\n${field.type === 'file' ? '请发送文件、图片或视频。' : '请回复本字段的值。'} 可回复“退出填写”。`;
  };
  const resumeStatus = async task => {
    if (!task.sessionId) return '回执已提交。';
    try {
      const response = await api('task.inspect', { target: { workspace: task.workspace, sessionId: task.sessionId } });
      const status = response.data.task?.status ?? response.data.status;
      if (status === 'running') return '回执已提交，关联会话当前正在运行。';
    } catch { /* Receipt succeeded independently of scheduler availability. */ }
    return '回执已提交，等待 runtime 调度器处理（parallel 工单不强制启动新一轮）。如未继续，请启动 auto-scheduler 或通过 /tasks 查看并调度。';
  };
  const writeReply = async (msg, capability, input) => {
    const id = hash(JSON.stringify([msg.accountId, msg.fromUserId, msg.messageId ?? randomUUID(), capability]));
    const op = state.replies[id] ??= { capability, input: { ...input, requestId: `wx-human-${id}` } };
    persist();
    if (!op.result) {
      try { op.result = await api(op.capability, op.input); }
      catch (error) {
        // Current runtime accepts requestId but does not replay all human-task writes.
        const { task } = await inspect(op.input.task.taskId);
        const matches = op.capability === 'human_task.reject'
          ? task.status === 'rejected' && task.rejection?.actor === op.input.actor && task.rejection.reason === op.input.reason
          : task.ack?.actor === op.input.actor;
        if (!matches) throw error;
        op.result = { data: { task } };
      }
      persist();
    }
    return op.result;
  };
  const observe = msg => {
    if (!allowed(msg.fromUserId) || msg.groupId) return false;
    const route = { accountId: msg.accountId, userId: msg.fromUserId }, userKey = keyOf(route.accountId, route.userId);
    if (msg.contextToken) {
      if (automatic && !state.autoRecipient) state.autoRecipient = route;
      state.contacts[userKey] = { token: msg.contextToken, at: now() };
      for (const e of Object.values(state.tasks)) if (!e.registered && (!e.route || same(e.route, route))) e.retryAt = 0;
      persist();
    }
    return true;
  };
  const handle = async msg => {
    if (!observe(msg)) return false;
    const route = { accountId: msg.accountId, userId: msg.fromUserId }, userKey = keyOf(route.accountId, route.userId);
    const raw = (msg.commandText ?? msg.text ?? '').trim();
    const inboundKey = msg.messageId ? hash(JSON.stringify([userKey, String(msg.messageId)])) : null;
    const command = /^\/human(?:\s+([\s\S]*))?$/i.exec(raw);
    // Context refresh and ordinary commands must work even while a backend call
    // or a Weixin notification is stalled. They only do synchronous state I/O.
    if (command && /^whoami(?:\s|$)/i.test(command[1] || '')) {
      await bot.reply(msg, `accountId: ${route.accountId}\nuserId: ${route.userId}`); return true;
    }
    const bypass = !command && /^\/(tasks|p|goal|sapiens|clear)(?:\s|$)/i.test(raw);
    if (!(inboundKey && state.completedMessages[inboundKey]) && !command && (!state.active[userKey] || bypass)) return false;

    return serial(async () => {
      if (inboundKey && state.completedMessages[inboundKey]) {
        await bot.reply(msg, state.completedMessages[inboundKey]); return true;
      }
      if (!command && (!state.active[userKey] || /^\/(tasks|p|goal|sapiens|clear)(?:\s|$)/i.test(raw))) return false;
      const reply = async text => {
        text += '\n人工回填模式中直接回复内容或发送附件；单独发送 human/ 退出模式。';
        for (const part of text.match(/[\s\S]{1,1800}/g) || ['']) await bot.reply(msg, part);
      };
      try {
        if (command) {
          const [alias, action, ...rest] = (command[1] || '').split(/\s+/);
          if (!alias || alias === 'help') {
            const visible = [];
            let cursor = 0;
            do {
              const response = await api('human_task.list', { all: true, open: true, limit: 100, cursor });
              for (const task of response.data.tasks) if (same(state.tasks[task.taskId]?.route || recipient(task), route)) visible.push(`${entry(task.taskId).alias} · ${task.title} · ${task.status}`);
              cursor = response.page?.cursor ?? null;
            } while (cursor != null);
            persist(); await reply(`${visible.join('\n') || '暂无分配给你的待办。'}\n\n${HELP}`); return true;
          }
          const taskId = aliasId(alias), { task } = await authorizedTask(taskId, route);
          if (!action) {
            await send(route, `${renderHumanTask(task, entry(taskId).alias)}\n当前状态：${task.status}`);
            if (OPEN.has(task.status)) {
              const dk = draftKey(route, taskId);
              state.drafts[dk] ??= { index: 0, outputs: {}, attachments: [], raw: [], seen: [] };
              state.active[userKey] = taskId; persist();
              await reply(`已进入 ${entry(taskId).alias} 的工单上下文。\n${promptField(task, state.drafts[dk])}`);
            } else { delete state.active[userKey]; persist(); }
            return true;
          }
          if (action === '接单') {
            if (!OPEN.has(task.status)) throw new Error(`工单已结束：${task.status}`);
            if (task.status === 'pending') throw new Error('工单投递尚未登记，请稍后接单（仍可直接填写回执）。');
            await writeReply(msg, 'human_task.ack', { task: ref(taskId), actor: route.userId });
            await reply('已接单。完成后请填写回执。'); return true;
          }
          if (action === '拒绝') {
            const reason = rest.join(' ').trim();
            if (!reason) throw new Error('请附上拒绝原因');
            await writeReply(msg, 'human_task.reject', { task: ref(taskId), actor: route.userId, reason });
            await reply(await resumeStatus(task)); return true;
          }
          if (action !== '填写') throw new Error(HELP);
          const dk = draftKey(route, taskId);
          if (!OPEN.has(task.status) && !state.drafts[dk]?.submission) throw new Error(`工单已结束：${task.status}`);
          state.drafts[dk] ??= { index: 0, outputs: {}, attachments: [], raw: [], seen: [] };
          state.active[userKey] = taskId; persist();
          await reply(promptField(task, state.drafts[dk])); return true;
        }
        const taskId = state.active[userKey], { task, inbox } = await authorizedTask(taskId, route);
        const dk = draftKey(route, taskId), draft = state.drafts[dk];
        if (raw === '退出填写') { delete state.active[userKey]; persist(); await reply('已退出，草稿保留。'); return true; }
        if (draft.submission) {
          if (raw !== '提交') throw new Error('上次提交结果待核验，请回复“提交”以相同请求重试，或“退出填写”。');
        } else {
          if (!OPEN.has(task.status)) throw new Error(`工单已结束：${task.status}`);
          if (raw === '重填') { state.drafts[dk] = { index: 0, outputs: {}, attachments: [], raw: [], seen: [] }; persist(); await reply(promptField(task, state.drafts[dk])); return true; }
          if (msg.messageId && draft.seen.includes(String(msg.messageId))) { await reply(promptField(task, draft)); return true; }
          const field = (task.requiredOutputs || [])[draft.index];
          if (field) {
            if (raw === '跳过' && !field.required) { /* Explicitly omit optional output. */ }
            else if (field.type === 'file') {
              // Only a newly received attachment, never quoted cached media or a typed local path.
              if (!msg.mediaPath || !msg.raw?.item_list?.some(item => [2, 3, 4, 5].includes(item.type) &&
                  [item.image_item, item.video_item, item.file_item, item.voice_item].some(value => value?.media?.encrypt_query_param || value?.media?.full_url))) throw new Error('请发送本字段的附件，不能用本地路径或引用消息代替');
              const ext = path.extname(msg.fileName || msg.mediaPath).toLowerCase();
              if (field.accept?.length && !field.accept.map(s => s.toLowerCase()).includes(ext)) throw new Error(`文件格式必须为 ${field.accept.join(' / ')}`);
              fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
              const destination = path.join(inbox, `${randomUUID()}${ext.replace(/[^.a-z0-9]/g, '')}`);
              fs.copyFileSync(msg.mediaPath, destination, fs.constants.COPYFILE_EXCL);
              draft.attachments.push({ field: field.name, path: destination });
            } else Object.defineProperty(draft.outputs, field.name, { value: parseHumanValue(field, raw), enumerable: true, writable: true, configurable: true });
            draft.raw.push(raw || `[附件:${msg.fileName || path.basename(msg.mediaPath || '')}]`);
            if (msg.messageId) draft.seen.push(String(msg.messageId));
            draft.index++; persist(); await reply(promptField(task, draft)); return true;
          }
          if (raw !== '提交') throw new Error('请回复“提交”、“重填”或“退出填写”。');
          draft.submission = { task: ref(taskId), actor: route.userId, outputs: draft.outputs, attachments: draft.attachments,
            rawText: draft.raw.join('\n').slice(0, 8000).trim(), channel: 'weixin', messageId: String(msg.messageId || `im-${randomUUID()}`),
            relayedBy: `im-metaagent:${route.accountId}`, requestId: `wx-complete-${randomUUID()}` };
          persist();
        }
        try {
          if (!completionMatches(task, draft.submission)) await api('human_task.complete', draft.submission);
        }
        catch (error) {
          const latest = await inspect(taskId).catch(() => null);
          if (latest && completionMatches(latest.task, draft.submission)) {
            // The original write succeeded, including moving attachments out of inbox.
          } else {
            // A definitive validation failure can be corrected. Unknown outcomes keep the exact request.
            if (error.code === 'INVALID_ARGUMENT') { delete draft.submission; persist(); }
            throw error;
          }
        }
        const statusText = await resumeStatus(task);
        if (inboundKey) state.completedMessages[inboundKey] = statusText;
        while (Object.keys(state.completedMessages).length > 1000) delete state.completedMessages[Object.keys(state.completedMessages)[0]];
        delete state.active[userKey]; delete state.drafts[dk]; persist();
        await reply(statusText); return true;
      } catch (error) { await reply(`人工工单：${error.message}`); return true; }
    });
  };
  return {
    handle, tick, observe,
    async handleInMode(msg, body) {
      if (!allowed(msg.fromUserId) || msg.groupId) { await bot.reply(msg, '人工工单请在授权的私聊中处理。'); return; }
      if (/^(查看|查看工单|列表|帮助)$/.test(body.trim())) body = 'help';
      const userKey = keyOf(msg.accountId, msg.fromUserId);
      state.modeContexts ??= {};
      if (msg.modeSessionId && state.modeContexts[userKey] !== msg.modeSessionId) {
        delete state.active[userKey]; state.modeContexts[userKey] = msg.modeSessionId; persist();
      }
      const inboundKey = msg.messageId ? hash(JSON.stringify([userKey, String(msg.messageId)])) : null;
      if (inboundKey && state.completedMessages[inboundKey]) return handle({ ...msg, commandText: body, text: body });
      const command = !body || /^(help|whoami|H\d+|ht-[0-9a-f]{16})(?:\s|$)/i.test(body);
      if (!command && !state.active[userKey]) { await bot.reply(msg, '请发送 H1 填写 选择要回填的工单，或发送 help 查看工单。'); return; }
      const value = body.replace(/^--value\s+/, '');
      return handle({ ...msg, commandText: command ? `/human ${body}` : value === '附件' && msg.mediaPath ? '' : value,
        text: command ? `/human ${body}` : value });
    },
    rememberOrigin(workspace, sessionId, msg) {
      if (!sessionId || msg.groupId) return;
      const id = JSON.stringify([workspace, sessionId]);
      if (state.origins[id]) return;
      state.origins[id] = { accountId: msg.accountId, userId: msg.fromUserId };
      persist();
    },
    async check() {
      const response = await api('human_task.list', { all: true, open: true, limit: 100 });
      const target = defaultRecipient || (automatic && state.autoRecipient);
      const defaultInfo = target
        ? `全项目默认收件人：${target.userId}（账号 ${target.accountId}，${defaultRecipient ? '手动配置' : '自动识别'}）。`
        : automatic ? '单人模式：等待你私聊机器人，自动识别并记住工单收件人，无需填写 userId。'
        : '使用已配置的项目收件人路由。';
      return `人工工单后端正常：本页 ${response.data.tasks.length} 张待办，已配置 ${routes.length} 条项目路由。\n${defaultInfo}\n续跑由 runtime auto-scheduler / tasks --manage 负责。`;
    },
    start() {
      fs.mkdirSync(stateDir, { recursive: true });
      lockPath = path.join(stateDir, 'human-tasks.lock');
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(lockPath, 'utf8'));
        let live = true;
        if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        if (live) { lockPath = undefined; throw new Error('人工工单消费者已运行，或锁文件需人工检查'); }
        fs.unlinkSync(lockPath); lockPath = undefined; return this.start();
      }
      const loop = async () => {
        try { await tick(); } catch (error) { log.warn(`人工工单轮询失败：${error.message}`); }
        if (!stopped) timer = setTimeout(loop, Math.max(1000, pollMs));
      };
      void loop();
    },
    async close() {
      stopped = true; clearTimeout(timer); await tail;
      if (lockPath) { fs.unlinkSync(lockPath); lockPath = undefined; }
    },
  };
}
