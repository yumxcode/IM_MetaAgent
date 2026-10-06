import { randomBytes } from "node:crypto";
import path from "node:path";

export const TASK_COMMANDS = `任务管理（meta-agent-glm）:
/tasks                    全部任务，含已完成
/tasks active             尚未完成的任务
/tasks running            正在运行的任务
/tasks projects           按项目汇总
/tasks recent             最近进展
/tasks show <任务>        状态、目标、进展、待办
/tasks progress <任务>    最近进展和活动
/tasks logs <任务> [条数] 最近活动（默认 10，最多 30）
/tasks report <任务>      最近一次完成报告
/tasks artifacts <任务>   产物路径
/tasks run-now <任务>     提前执行已安排的唤醒
/tasks cancel <任务>      取消等待，不删除历史
/tasks steer <任务> <指令> 调整后续执行方向
/tasks kill <任务>        终止当前轮次（需确认）
/tasks rm <任务>          删除任务和历史（需确认）
/tasks confirm <确认码>   确认上一次终止或删除
/tasks manage status      查看微信自动调度状态
/tasks manage start [并发数] 启动自动调度
/tasks manage stop        停止接收新轮次，已运行轮次继续
任务可用上次列表序号、session ID 前缀或唯一项目名。
读取不会启动调度；已失败或已完成任务不会被 run-now 重新创建。`;

const STATUS = {
  running: "运行中", parked: "等待唤醒", overdue: "唤醒逾期",
  "stale-claim": "运行租约过期", orphaned: "调度丢失", failed: "失败/中断", finished: "已结束",
};
const ACTIVITY_KIND = {
  agent: "输出", thinking: "思考", tool: "工具", "tool-result": "工具结果",
  warning: "提醒", error: "错误", status: "状态", report: "报告",
};

/** Recognise only explicit commands and a few complete natural-language requests. */
export function parseTaskCommand(raw, { allowNatural = false } = {}) {
  const text = String(raw ?? "").trim();
  const explicit = text.match(/^\/tasks(?:\s+([\s\S]*))?$/i);
  let rest;
  if (explicit) rest = explicit[1] ?? "";
  else if (allowNatural) {
    if (/^(查看任务|任务列表|所有任务)$/.test(text)) rest = "list";
    else if (/^(运行中的项目|运行中的任务)$/.test(text)) rest = "running";
    else {
      const match = text.match(/^(最近进展|查看进展)(?:\s+([\s\S]+))?$/);
      if (!match) return null;
      rest = match[2] ? `progress ${match[2]}` : "recent";
    }
  } else return null;
  const match = rest.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const command = (match?.[1] ?? "list").toLowerCase();
  const args = match?.[2]?.trim() ?? "";
  const first = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { command: command === "--manage" ? "manage" : command,
    selector: first?.[1] ?? "", text: first?.[2] ?? "", args };
}

function clip(value, max = 400) {
  const text = String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function timestamp(value) {
  if (!Number.isFinite(value)) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) + " 北京时间";
}
const identity = task => ({ sessionId: task.sessionId, workspace: task.workspace });
const sameTask = (a, b) => a.sessionId === b.sessionId && a.workspace === b.workspace;
const label = task => `${path.basename(task.workspace)} · ${task.sessionId}`;
const status = task => STATUS[task.status] ?? task.status;
const sorted = tasks => [...tasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.workspace.localeCompare(b.workspace) || a.sessionId.localeCompare(b.sessionId));

export function createTaskChat({ backend, maxRunning = 3, now = Date.now, token = () => randomBytes(4).toString("hex") }) {
  const views = new Map();
  const pending = new Map();
  let mutationTail = Promise.resolve();
  const scope = msg => JSON.stringify([msg.accountId, msg.fromUserId, msg.groupId ?? ""]);
  const view = msg => {
    const key = scope(msg);
    if (!views.has(key)) views.set(key, { rows: [], selected: null });
    return views.get(key);
  };
  function resolveTask(msg, selector, tasks, selection) {
    const state = view(msg);
    let matches;
    if (!selector) {
      matches = selection?.task ? tasks.filter(t => sameTask(t, selection.task)) : tasks.length === 1 ? tasks : [];
    } else if (/^[1-9]\d*$/.test(selector)) {
      const saved = selection?.task;
      if (!saved) throw new Error("序号不在上次任务列表内，请先发 /tasks。");
      matches = tasks.filter(t => sameTask(t, saved));
    } else {
      const exact = tasks.filter(t => t.sessionId === selector);
      matches = exact.length ? exact : tasks.filter(t => t.sessionId.startsWith(selector) || path.basename(t.workspace) === selector || t.workspace === selector);
    }
    if (!matches.length) throw new Error("未找到任务，请发 /tasks 查看列表，再使用序号或 session ID。");
    if (matches.length > 1) throw new Error(`匹配到 ${matches.length} 个任务，请使用唯一 session ID 前缀：\n` + matches.map(t => label(t)).join("\n"));
    state.selected = identity(matches[0]);
    return matches[0];
  }

  function renderList(msg, tasks, title) {
    view(msg).rows = tasks.map(identity);
    const counts = new Map();
    for (const task of tasks) counts.set(status(task), (counts.get(status(task)) ?? 0) + 1);
    if (!tasks.length) return `${title}：0 个任务。\n用 /tasks 查看全部历史任务。`;
    const lines = tasks.map((task, index) => `${index + 1}. ${path.basename(task.workspace)} [${status(task)}]\n   ID: ${task.sessionId}\n   目标: ${clip(task.goal || "（未记录）", 180)}\n   更新: ${timestamp(task.updatedAt)}`);
    return `${title}：${tasks.length} 个\n${[...counts].map(([name, n]) => `${name} ${n}`).join(" · ")}\n\n${lines.join("\n\n")}\n\n/tasks show <序号> 查看详情；/tasks help 查看操作。`;
  }

  function progress(task) {
    const p = task.progress ?? {};
    const done = (p.completedSteps ?? []).slice(-5);
    const todos = p.pendingTodos ?? [];
    return `最近记录: ${timestamp(task.updatedAt)}\n进展: ${clip(task.note || "（暂无进展摘要）", 2400)}` +
      (done.length ? `\n\n最近完成:\n${done.map(t => "• " + clip(t, 700)).join("\n")}` : "") +
      (todos.length ? `\n\n待办:\n${todos.map(t => "• " + clip(t, 700)).join("\n")}` : "\n待办: （未记录）");
  }

  function detail(task) {
    const p = task.progress ?? {};
    const health = task.health ?? {};
    return `${label(task)}\n状态: ${status(task)}\n工作区: ${task.workspace}\n目标: ${clip(task.goal || "（未记录）", 2400)}\n` +
      `轮数: ${p.turnCount ?? 0} · 估算费用: $${Number(p.estimatedCostUsd ?? 0).toFixed(4)}\n` +
      `调度器: ${task.scheduler?.alive ? "在线" : "离线"}${task.scheduler?.pid ? ` (PID ${task.scheduler.pid})` : ""}\n` +
      (task.wake ? `下次唤醒: ${timestamp(task.wake.fireAt)}\n原因: ${clip(task.wake.reason, 600)}\n` : "") +
      (task.stopReason ? `停止原因: ${task.stopReason}\n` : "") +
      `等待调整指令: ${task.pendingSteerCount ?? 0} · 压缩: ${health.compactions ?? 0} · 验收拒绝: ${health.verifyRejections ?? 0}\n\n` + progress(task);
  }

  async function renderActivity(task, limit, reportOnly = false) {
    const feed = await backend.activity(task, { reportOnly });
    if (feed.error) return `活动读取失败: ${clip(feed.error, 800)}`;
    if (reportOnly) {
      if (!feed.report) return "暂无此轮完成报告。可用 /tasks progress 查看已有进展记录。";
      const report = feed.report;
      return `最近一次完成报告${report.stopReason ? ` (${report.stopReason})` : ""}:\n` +
        (report.text || "（无结尾正文）") + (report.diagnosis ? `\n\n终止诊断:\n${report.diagnosis}` : "") +
        (report.clipped ? "\n（报告较长，已截取）" : "");
    }
    if (!feed.entries?.length) return "暂无可读取的管理器活动日志。进展摘要来自已持久化记录，可能早于正在运行的输出。";
    const entries = feed.entries.slice(-limit);
    return "最近活动:\n" + entries.map(e => `[${ACTIVITY_KIND[e.kind] ?? e.kind}] ${clip(e.text, 1200)}`).join("\n\n") +
      (feed.truncated || entries.length < feed.entries.length ? "\n（仅显示最近部分）" : "");
  }

  const isMutation = command => ["run-now", "cancel", "steer", "kill", "rm", "delete", "confirm", "manage"].includes(command);
  async function execute(msg, request, selection) {
    const { command, selector, text, args } = request;
    if (command === "help" || command === "--help") return TASK_COMMANDS;
    if (command === "manage") {
      const sub = selector || "status";
      if (sub === "status") {
        const s = backend.managerStatus();
        return `微信自动调度: ${s.enabled ? "已启动" : "未启动"}\n运行轮次: ${s.running} · 排队: ${s.queued} · 并发上限: ${s.maxRunning || maxRunning}` +
          (s.lastError ? `\n最近错误: ${clip(s.lastError, 800)}` : "") + "\n/tasks manage start 启动；/tasks manage stop 停止接收新轮次。";
      }
      if (sub === "start") {
        if (text && (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))) throw new Error("并发数必须为正整数。");
        return (await backend.startManaging(text ? Number(text) : maxRunning)).message;
      }
      if (sub === "stop" && !text) return (await backend.stopManaging()).message;
      throw new Error("用法: /tasks manage status | start [并发数] | stop");
    }
    if (command === "confirm") {
      const key = `${scope(msg)}/${selector}`;
      const intent = pending.get(key);
      if (!intent || intent.expiresAt <= now()) {
        pending.delete(key);
        throw new Error("确认码无效或已过期，请重新发起终止/删除操作。");
      }
      pending.delete(key);
      const tasks = await backend.list();
      const task = tasks.find(t => sameTask(t, intent.task));
      if (!task) throw new Error("任务已不存在，未执行操作。");
      if (intent.kind === "delete" && task.status === "running") throw new Error("任务正在执行，请先终止，待轮次退出后再删除。");
      if (intent.kind === "kill") {
        if (!["running", "stale-claim"].includes(task.status)) throw new Error("此任务没有正在执行的轮次。");
        if (!intent.wakeId || task.wake?.wakeId !== intent.wakeId) throw new Error("任务执行轮次已改变，未执行终止。请重新发送 /tasks kill。");
      }
      const result = await backend.action(task, intent.kind, "", { confirmed: true,
        ...(intent.kind === "kill" ? { expectedWakeId: intent.wakeId } : {}) });
      return `${result.ok ? "✅" : "❌"} ${label(task)}\n${result.message}`;
    }
    const tasks = sorted(await backend.list());
    if (["list", "ls", "all", "active", "running"].includes(command)) {
      if (args) throw new Error("筛选命令不接受参数，请用 /tasks show <任务> 查看详情。");
      const shown = tasks.filter(t => command === "running" ? t.status === "running" : command === "active" ? t.status !== "finished" : true);
      return renderList(msg, shown, command === "running" ? "运行中任务" : command === "active" ? "尚未完成任务" : "任务列表");
    }
    if (command === "projects") {
      const projects = new Map();
      for (const task of tasks) {
        if (!projects.has(task.workspace)) projects.set(task.workspace, []);
        projects.get(task.workspace).push(task);
      }
      return `任务项目：${projects.size} 个\n\n` + [...projects].map(([workspace, members]) => `${path.basename(workspace)}\n${workspace}\n${members.length} 个任务，运行中 ${members.filter(t => t.status === "running").length}\n最近: ${clip(members[0].note || members[0].goal, 500)}`).join("\n\n");
    }
    if (command === "recent") {
      if (!tasks.length) return "暂无任务进展。";
      view(msg).rows = tasks.slice(0, 5).map(identity);
      return `最近进展（${Math.min(5, tasks.length)}/${tasks.length} 个任务）:\n\n` + tasks.slice(0, 5).map((t, i) => `${i + 1}. ${label(t)} [${status(t)}]\n${timestamp(t.updatedAt)}\n${clip(t.note || t.goal || "（暂无记录）", 1200)}`).join("\n\n");
    }
    const known = ["show", "progress", "logs", "report", "artifacts", "run-now", "cancel", "steer", "kill", "rm", "delete"];
    if (!known.includes(command)) return `无法识别任务指令: ${clip(command, 80)}\n\n${TASK_COMMANDS}`;
    const task = resolveTask(msg, selector, tasks, selection);
    if (command === "show") return detail(task);
    if (command === "progress") return `${label(task)} [${status(task)}]\n${progress(task)}\n\n${await renderActivity(task, 5)}`;
    if (command === "logs") {
      if (text && (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 30)) throw new Error("活动条数应在 1–30 之间。");
      return `${label(task)}\n${await renderActivity(task, text ? Number(text) : 10)}`;
    }
    if (command === "report") return `${label(task)}\n${await renderActivity(task, 10, true)}`;
    if (command === "artifacts") {
      const artifacts = task.progress?.artifacts ?? [];
      return `${label(task)}\n工作区: ${task.workspace}\n产物路径（${artifacts.length}）:\n` + (artifacts.length ? artifacts.join("\n") : "（暂无登记产物）");
    }
    if (command === "kill" || command === "rm" || command === "delete") {
      const kind = command === "kill" ? "kill" : "delete";
      if (kind === "kill" && !["running", "stale-claim"].includes(task.status)) throw new Error("此任务没有正在执行的轮次。");
      if (kind === "kill" && !task.wake?.wakeId) throw new Error("无法确定当前轮次标识，请重新查询任务。");
      if (kind === "delete" && task.status === "running") throw new Error("任务正在执行，请先终止，待轮次退出后再删除。");
      for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key);
      const confirmation = token();
      pending.set(`${scope(msg)}/${confirmation}`, { task: identity(task), kind,
        wakeId: kind === "kill" ? task.wake.wakeId : undefined, expiresAt: now() + 60_000 });
      return `${kind === "kill" ? "将终止当前轮次，已写入的工作区变更会保留" : "将永久删除任务、检查点和对话历史，无法恢复"}。\n任务: ${label(task)}\n工作区: ${task.workspace}\n确认请在 60 秒内发送: /tasks confirm ${confirmation}`;
    }
    if (command === "steer" && !text.trim()) throw new Error("用法: /tasks steer <任务> <补充指令>");
    const result = await backend.action(task, command, command === "steer" ? text : "");
    return `${result.ok ? "✅" : "❌"} ${label(task)}\n${result.message}`;
  }

  return {
    async handle(msg, request) {
      // A list response or selection can change while backend I/O or earlier mutations await.
      // Bind chat-relative selectors at receipt, then revalidate their full identity in fresh data.
      let selection;
      if (!request.selector || /^[1-9]\d*$/.test(request.selector)) {
        const state = view(msg);
        const selected = request.selector ? state.rows[Number(request.selector) - 1] : state.selected;
        selection = { task: selected ? { ...selected } : null };
      }
      const run = async () => {
        try { return await execute(msg, request, selection); }
        catch (error) { return `❌ 任务操作失败: ${clip(error.message, 1200)}`; }
      };
      if (!isMutation(request.command)) return run();
      const work = mutationTail.then(run, run);
      mutationTail = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}
