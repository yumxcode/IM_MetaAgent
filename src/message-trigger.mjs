/** The sender allowlist applies to every command, before any route is selected. */
const NATURAL_TASKS = /^(查看任务|任务列表|所有任务|运行中的项目|运行中的任务|最近进展(?:\s+[\s\S]+)?|查看进展(?:\s+[\s\S]+)?)$/;

/**
 * Recognise explicit /tasks commands and a few complete natural-language
 * requests. Returns the console prompt string ("" for a bare /tasks), or null
 * when the text is not a task-ops request.
 */
export function parseTasksCommand(raw, { allowNatural = false } = {}) {
  const text = String(raw ?? "").trim();
  const explicit = text.match(/^\/tasks(?:\s+([\s\S]*))?$/i);
  if (explicit) return (explicit[1] ?? "").trim();
  if (allowNatural && NATURAL_TASKS.test(text)) return text;
  return null;
}

export function parseAgentTrigger(msg, cfg) {
  const raw = (msg.commandText ?? msg.text)?.trim();
  const fullPrompt = msg.text?.trim() || raw;
  if (cfg.allowFrom.length && !cfg.allowFrom.includes(msg.fromUserId)) return { action: "ignore" };
  if (!raw) return { action: "ignore" };

  // /tasks is an explicit command and works in groups regardless of group policy.
  const direct = parseTasksCommand(raw, { allowNatural: !msg.groupId });
  if (direct !== null) return { action: "tasks", prompt: direct };
  if (raw === "/clear") return { action: "clear" };
  if (raw === "/p" || raw.startsWith("/p ")) {
    const parts = (raw === "/p" ? "" : raw.slice(3).trim()).split(/\s+/);
    return { action: "project", subcmd: parts[0] || "", args: parts.slice(1) };
  }
  if (raw === "/goal" || raw.startsWith("/goal ")) return { action: "goal", prompt: raw === "/goal" ? "" : [msg.quoteContext, raw.slice(6).trim()].filter(Boolean).join("\n") };
  if (!msg.groupId) return { action: "respond", prompt: fullPrompt };
  if (cfg.groupTrigger === "off") return { action: "ignore" };
  if (cfg.groupTrigger === "all") {
    const prompt = parseTasksCommand(raw, { allowNatural: true });
    return prompt !== null ? { action: "tasks", prompt } : { action: "respond", prompt: fullPrompt };
  }
  if (!raw.startsWith(cfg.triggerPrefix)) return { action: "ignore" };
  const prompt = raw.slice(cfg.triggerPrefix.length).replace(/^@\S+\s*/, "").trim();
  const taskPrompt = parseTasksCommand(prompt, { allowNatural: true });
  return taskPrompt !== null ? { action: "tasks", prompt: taskPrompt } : { action: prompt ? "respond" : "ignore", prompt: [msg.quoteContext, prompt].filter(Boolean).join("\n") };
}
