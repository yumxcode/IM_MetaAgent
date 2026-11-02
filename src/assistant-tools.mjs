/**
 * Tools the resident assistant calls back into IM for (declared to
 * `meta-agent serve --host-tools`). IM runs them with its own authority and
 * validates every input; nothing here trusts the model:
 *  - folders: only inside IM_WORKSPACE_ROOTS, metadata reads only;
 *  - work: task_propose only *proposes* — IM sends the confirmation card and
 *    starts the task when the user replies, never on the model's word;
 *  - reminders, decisions, steering and cancelling reuse the bot's own checks.
 */
import { listWorkspaces, peekWorkspace } from './workspaces.mjs';
import { planSchedule } from './schedules.mjs';
import { createTasksAgenticConsole } from './tasks-agentic.mjs';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });

export const ASSISTANT_TOOL_SPECS = [
  { name: 'workspace_search', readOnly: true, description: '在用户允许的电脑文件夹（IM_WORKSPACE_ROOTS）中，按用户意图查找可能的工作目录。返回候选文件夹的路径、名称、README 摘要、git 信息和以前在这里做过的任务。query 写用户描述的项目特征（可为空，返回最近使用/修改的文件夹）。',
    inputSchema: obj({ query: str('用户描述的项目或文件夹特征，例如“微信机器人项目”“上个月的投标资料”') }) },
  { name: 'workspace_list', readOnly: true, description: '浏览允许范围内的文件夹：不传 path 列出各根目录及其一级子文件夹；传 path 列出该文件夹下的子文件夹（含 git 分支、修改日期）。',
    inputSchema: obj({ path: str('要浏览的文件夹，绝对路径或 ~/ 开头') }) },
  { name: 'workspace_peek', readOnly: true, description: '查看某个文件夹的详细信息：README 摘要、package/pyproject 信息、git 分支与未提交改动数、最近提交和两层目录结构。用于确认是不是用户说的那个项目。',
    inputSchema: obj({ path: str('文件夹路径，绝对路径或 ~/ 开头') }, ['path']) },
  { name: 'task_propose', description: '提议启动一个工作任务（auto，长时间多步骤的工程工作）。IM 会给用户发送带编号的确认消息，用户回复“确认”后才会创建文件夹（如需要）并开工；你不能替用户确认，也不要说任务已经开始。新的提议会取代该用户尚未确认的旧提议。目录三选一：workspace（已有文件夹）、create（新建文件夹）、都不填（任务专用的独立空目录）。',
    inputSchema: obj({
      goal: str('交给工作任务的完整目标，写清楚要做什么、交付什么'),
      workspace: str('已有的工作文件夹，绝对路径或 ~/ 开头'),
      create: obj({ parent: str('在哪个文件夹下新建'), name: str('新文件夹名') }, ['parent', 'name']),
      alternatives: { type: 'array', items: { type: 'string' }, maxItems: 3, description: '其他候选文件夹（用户可回复编号改选）' },
      reason: str('为什么选这个目录（一句话，展示给用户）'),
      sapiens: { type: 'boolean', description: '需要人工配合（人工工单）时为 true' },
    }, ['goal']), timeoutMs: 30000 },
  { name: 'task_status', readOnly: true, description: '查询用户的工作任务。不传 task 列出全部任务（编号、状态、目标、目录）；传 task（如 A3）返回详情、最近结果和待决策问题。',
    inputSchema: obj({ task: str('任务编号，如 A3') }) },
  { name: 'task_steer', description: '给已有的工作任务补充要求并继续执行（任务正在运行时会被拒绝）。IM 会把补充内容回显给用户。',
    inputSchema: obj({ task: str('任务编号，如 A3'), text: str('补充要求') }, ['task', 'text']) },
  { name: 'task_decide', description: '把用户对【待决策】问题的回答交给对应任务并继续执行。只有用户明确给出决定时才调用。',
    inputSchema: obj({ task: str('任务编号，如 A3'), answer: str('用户的决定，尽量保留原话') }, ['task', 'answer']) },
  { name: 'task_cancel', description: '取消工作任务当前排队或正在执行的一轮（任务记录和上下文保留，之后可继续）。只有用户明确要求时才调用。',
    inputSchema: obj({ task: str('任务编号，如 A3') }, ['task']) },
  { name: 'reminder_create', description: '创建提醒或定时任务。只有用户明确要求时才调用；时间不明确先问。at 与 cron 二选一。kind=remind 到点发提醒；kind=talk 到点把 text 作为指令交给助理执行并发送结果。',
    inputSchema: obj({ text: str('提醒内容，或定时执行的指令'), at: str('一次性时间，"YYYY-MM-DD HH:mm"（用户时区）'), cron: str('重复规则，5 段 cron，如 "0 8 * * 1-5"'), kind: { type: 'string', enum: ['remind', 'talk'] } }, ['text']) },
  { name: 'reminder_list', readOnly: true, description: '列出用户当前有效的提醒和定时任务。', inputSchema: obj({}) },
  { name: 'reminder_cancel', description: '取消一个提醒或定时任务。', inputSchema: obj({ id: str('提醒编号，如 R3') }, ['id']) },
  { name: 'human_open', description: '用户想查看或填写人工工单时调用：不传 ticket 发送待办列表；传 ticket（如 H1）进入该工单的逐项填写（之后用户的消息直接作为字段值，直到提交或“退出填写”）。',
    inputSchema: obj({ ticket: str('工单编号，如 H1') }) },
  { name: 'ops_query', description: '查询或运维 runtime 后台任务（非微信创建的任务、调度器状态等），由任务运维控制台回答。耗时较长，仅在用户问后台任务时使用。',
    inputSchema: obj({ question: str('用户的运维问题') }, ['question']), timeoutMs: 330000 },
];

const ok = content => ({ content: typeof content === 'string' ? content : JSON.stringify(content, null, 1), isError: false });
const fail = message => ({ content: message, isError: true });
const taskId = value => { const m = /^A\d+$/i.exec(String(value || '').trim()); if (!m) throw new Error('任务编号格式应为 A1'); return m[0].toUpperCase(); };

export function createAssistantTools(agent) {
  const roots = () => agent.cfg.workspaceRoots || [];
  const handlers = {
    async workspace_search({ query = '' }, ctx) {
      if (!roots().length) return fail('未配置 IM_WORKSPACE_ROOTS：无法访问电脑上的文件夹，只能使用任务专用的独立目录（task_propose 不填目录）。');
      const used = new Map();
      for (const task of Object.values(agent.store.state.tasks)) {
        if (task.owner !== ctx.owner) continue;
        used.set(task.workspace, [...(used.get(task.workspace) || []), task.goal.slice(0, 80)]);
      }
      const last = agent.store.state.lastWorkspace?.[ctx.owner];
      const results = agent.catalog.search(query, { used });
      return ok({ ...(last ? { lastUsed: agent.display(last) } : {}), results, ...(results.length ? {} : { hint: '没有匹配项，可用 workspace_list 浏览，或提议新建文件夹' }) });
    },
    async workspace_list({ path }) { return ok(listWorkspaces(roots(), path)); },
    async workspace_peek({ path }) { return ok(await peekWorkspace(roots(), path)); },
    async task_propose(input, ctx) {
      const proposal = await agent.createProposal(ctx, input);
      return ok(`已向用户发送确认消息 ${proposal.id}，等待用户回复“确认”。在用户确认前任务不会开始；不要声称已经开始。`);
    },
    async task_status({ task }, ctx) { return ok(agent.taskSummary(ctx.owner, task ? taskId(task) : null)); },
    async task_steer({ task, text }, ctx) { return ok(agent.runTool(ctx, state => agent.steerTask(state, ctx, taskId(task), String(text || '').trim()))); },
    async task_decide({ task, answer }, ctx) { return ok(agent.runTool(ctx, state => agent.decideTask(state, ctx, taskId(task), String(answer || '').trim()))); },
    async task_cancel({ task }, ctx) { return ok(agent.runTool(ctx, state => agent.cancelTask(state, ctx.owner, taskId(task), ctx.msg, `${ctx.key}:cancel`))); },
    async reminder_create({ text, at, cron, kind = 'remind' }, ctx) {
      const timeZone = agent.timeZoneOf(ctx.owner);
      const plan = planSchedule({ text, at, cron, kind }, agent.now(), { timeZone });
      const lines = agent.runTool(ctx, state => agent.applyScheduleOps(state, ctx.owner, ctx.origin, [{ type: 'create', ...plan, timeZone }]));
      agent.noteTurn(ctx.executionId, lines);
      return /未生效/.test(lines.join('')) ? fail(lines.join('\n')) : ok(lines.join('\n'));
    },
    async reminder_list(_input, ctx) { return ok(agent.listSchedules(ctx.owner)); },
    async reminder_cancel({ id }, ctx) {
      const lines = agent.runTool(ctx, state => agent.applyScheduleOps(state, ctx.owner, ctx.origin, [{ type: 'cancel', id: String(id || '').trim().toUpperCase() }]));
      agent.noteTurn(ctx.executionId, lines);
      return /未生效/.test(lines.join('')) ? fail(lines.join('\n')) : ok(lines.join('\n'));
    },
    async human_open({ ticket }, ctx) {
      if (!agent.human) return fail('人工工单未开启（META_AGENT_HUMAN_ENABLED=true）。');
      const id = ticket ? String(ticket).trim() : '';
      if (id && !/^(?:H\d+|ht-[0-9a-f]{16})$/i.test(id)) return fail('工单编号格式应为 H1');
      await agent.human.handleInMode({ ...ctx.msg, messageId: `${ctx.key}:human` }, id ? `${id} 填写` : 'help');
      return ok(id ? `已把 ${id} 的填写入口发给用户；之后用户的消息会直接作为字段值，直到提交或“退出填写”。` : '已把待办工单列表发给用户。');
    },
    async ops_query({ question }, ctx) {
      const settings = agent.adapter.settings('tasks');
      const console_ = createTasksAgenticConsole({ env: agent.adapter.env, opsRoot: agent.opsRoot(ctx.owner, 'assistant'),
        bin: settings.bin, profile: settings.profile, runtimeDir: settings.runtimeDir });
      try { return ok(await console_.turn(String(question || ''), { signal: ctx.signal })); }
      finally { await console_.close(); }
    },
  };
  return {
    specs: ASSISTANT_TOOL_SPECS.map(({ name, description, inputSchema, readOnly, timeoutMs }) => ({ name, description, inputSchema, ...(readOnly ? { readOnly } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) })),
    async call(name, input, meta) {
      const handler = handlers[name];
      if (!handler) return fail(`未知工具 ${name}`);
      let ctx;
      try { ctx = agent.toolContext(meta); }
      catch (error) { return fail(error.message); }
      try { return await handler(input || {}, ctx); }
      catch (error) { return fail(error.message); }
    },
  };
}
