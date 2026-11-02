/**
 * Inbound routing (1.5): there are no modes to enter or leave. Every ordinary
 * message goes to the resident assistant; a few slash commands remain as
 * optional shortcuts. Contextual routing (form filling, quoted notices,
 * proposal confirmations) happens in PersonalAgent, which owns that state.
 */
export const COMMAND_HELP = `直接发消息即可：聊天、搜索、提醒由助理直接处理；较大的工作，助理会先和你确认工作文件夹，再启动工作任务。
快捷命令（可选）：
/auto 目标：明确作为工作任务交办
/tasks：查看工作任务；/tasks inspect A1、cancel A1、resend A1；/tasks 其他内容：后台任务运维
/pending 查看待处理；/respond H1 填写 选择工单，/respond 内容 回填
/new 新建聊天上下文；/notify 查看通知设置`;

/** Pre-1.5 standalone mode markers. They no longer switch anything. */
const LEGACY_TOKEN = /^(?:\/(?:talk|auto|tasks|human)|(?:talk|auto|tasks|human)\/)$/i;

export function parseAgentTrigger(msg, cfg = {}) {
  if (cfg.allowFrom?.length && !cfg.allowFrom.includes('*') && !cfg.allowFrom.includes(msg.fromUserId)) return { action: 'ignore' };
  if (msg.groupId && cfg.groupTrigger === 'off') return { action: 'ignore' };
  const own = String(msg.commandText ?? msg.text ?? '').trim();
  const hasMedia = Boolean(msg.mediaPath || msg.mediaItem);
  if (/^\/notify(?:\s|$)/i.test(own)) return { action: 'notification', prompt: own.replace(/^\/notify\s*/i, '') };
  if (/^\/(?:pending|human)$/i.test(own)) return { action: 'human', prompt: 'help' };
  if (/^\/respond\s+\S/i.test(own)) return { action: 'human', prompt: own.replace(/^\/respond\s+/i, '') };
  if (/^(?:\/new|\/clear|--clear)$/i.test(own)) return { action: 'talk', prompt: '--clear' };
  if (/^\/tasks$/i.test(own)) return { action: 'tasks', prompt: 'im' };
  let m = /^\/tasks\s+([\s\S]+)$/i.exec(own);
  if (m) return { action: 'tasks', prompt: m[1].trim() };
  m = /^\/auto\s+([\s\S]+)$/i.exec(own);
  if (m) return { action: 'auto', prompt: m[1].trim() };
  m = /^\/talk\s+([\s\S]+)$/i.exec(own);
  if (m) return { action: 'talk', prompt: m[1].trim() };
  if (LEGACY_TOKEN.test(own)) return { action: 'legacy', token: own.toLowerCase() };
  if (!own && !hasMedia) return { action: 'ignore' };
  return { action: 'talk', prompt: own || '请查看附件并概括其内容。' };
}

export function legacyHint(token) {
  if (token === '/auto') return '现在不需要进入模式：直接说要做的事，助理会和你确认工作文件夹后开工；也可以发送 /auto 目标。';
  if (token === '/tasks') return '发送 /tasks 查看工作任务，或直接问助理“A1 进展如何”。';
  return '现在不需要进入或退出模式，直接发消息即可。';
}
