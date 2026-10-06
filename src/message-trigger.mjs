import { parseTaskCommand } from "./task-chat.mjs";

/** The sender allowlist applies to every command, before any route is selected. */
export function parseAgentTrigger(msg, cfg) {
  const raw = (msg.commandText ?? msg.text)?.trim();
  const fullPrompt = msg.text?.trim() || raw;
  if (cfg.allowFrom.length && !cfg.allowFrom.includes(msg.fromUserId)) return { action: "ignore" };
  if (!raw) return { action: "ignore" };

  const taskRequest = parseTaskCommand(raw, { allowNatural: !msg.groupId });
  if (taskRequest) return { action: "tasks", request: taskRequest };
  if (raw === "/clear") return { action: "clear" };
  if (raw === "/p" || raw.startsWith("/p ")) {
    const parts = (raw === "/p" ? "" : raw.slice(3).trim()).split(/\s+/);
    return { action: "project", subcmd: parts[0] || "", args: parts.slice(1) };
  }
  if (raw === "/goal" || raw.startsWith("/goal ")) return { action: "goal", prompt: raw === "/goal" ? "" : [msg.quoteContext, raw.slice(6).trim()].filter(Boolean).join("\n") };
  if (!msg.groupId) return { action: "respond", prompt: fullPrompt };
  if (cfg.groupTrigger === "off") return { action: "ignore" };
  if (cfg.groupTrigger === "all") {
    const request = parseTaskCommand(raw, { allowNatural: true });
    return request ? { action: "tasks", request } : { action: "respond", prompt: fullPrompt };
  }
  if (!raw.startsWith(cfg.triggerPrefix)) return { action: "ignore" };
  const prompt = raw.slice(cfg.triggerPrefix.length).replace(/^@\S+\s*/, "").trim();
  const request = parseTaskCommand(prompt, { allowNatural: true });
  return request ? { action: "tasks", request } : { action: prompt ? "respond" : "ignore", prompt: [msg.quoteContext, prompt].filter(Boolean).join("\n") };
}
