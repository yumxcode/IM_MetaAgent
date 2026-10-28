export const MODE_NAMES = { tasks: '任务运维', human: '人工回填', talk: '聊天', auto: '工作执行' };
export const COMMAND_HELP = `请单独发送 /tasks、/human、/talk 或 /auto 进入对应模式。
进入后直接发送内容，无需每句话加标记。
单独发送当前模式的 tasks/、human/、talk/ 或 auto/ 退出。
切换模式前，请先退出当前模式。`;

/** Only the sender's own standalone message may enter or exit a mode. */
export function parseModeMessage(value, current, { hasMedia = false } = {}) {
  const raw = String(value ?? '').trim();
  const enter = /^\/(tasks|human|talk|auto)$/i.exec(raw);
  const exit = /^(tasks|human|talk|auto)\/$/i.exec(raw);
  if (enter) {
    const mode = enter[1].toLowerCase();
    if (current) return { action: 'invalid', reason: current.kind === mode
      ? `当前已处于${MODE_NAMES[mode]}模式，请直接发送内容；退出请单独发送 ${mode}/。`
      : `当前处于${MODE_NAMES[current.kind]}模式，请先单独发送 ${current.kind}/ 退出，再发送 /${mode}。` };
    return { action: 'enter', mode };
  }
  if (exit) {
    const mode = exit[1].toLowerCase();
    if (!current) return { action: 'invalid', reason: `当前未进入任何模式，不能使用 ${mode}/。` };
    if (current.kind !== mode) return { action: 'invalid', reason: `当前处于${MODE_NAMES[current.kind]}模式，只能使用 ${current.kind}/ 退出。` };
    return { action: 'exit', mode };
  }
  if (/^\/(tasks|human|talk|auto)(?=\s|$)/i.test(raw)) return { action: 'invalid', reason: '进入模式的命令必须单独发送，例如 /tasks；请勿把命令和内容放在同一条消息中。' };
  if (!current) return { action: 'invalid', reason: '当前未进入任何模式，请先单独发送 /tasks、/human、/talk 或 /auto。' };
  if (!raw && !hasMedia) return { action: 'invalid', reason: '请发送内容，或单独发送当前模式的退出标记。' };
  const prompt = raw || (current.kind === 'human' ? '附件' : '请查看附件并概括其内容。');
  return { action: current.kind, prompt, modeSessionId: current.sessionId };
}

export function parseAgentTrigger(msg, cfg = {}, current) {
  if (cfg.allowFrom?.length && !cfg.allowFrom.includes('*') && !cfg.allowFrom.includes(msg.fromUserId)) return { action: 'ignore' };
  if (msg.groupId && cfg.groupTrigger === 'off') return { action: 'ignore' };
  return parseModeMessage(msg.commandText ?? msg.text, current, { hasMedia: Boolean(msg.mediaPath || msg.mediaItem) });
}
