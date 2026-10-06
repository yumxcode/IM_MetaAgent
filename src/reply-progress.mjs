import { generateId, log } from "./util.mjs";

/** A bounded serialized queue: iLink receives names/status, never tool inputs or output. */
export function createReplyProgress(bot, msg, { enabled = true, maxPending = 32 } = {}) {
  const runId = msg.runId || generateId("run");
  let chain = Promise.resolve(), pending = 0, finalized = false, failed = false;
  const tools = new Map();
  function enqueue(args) {
    if (!enabled || failed) return;
    pending++;
    chain = chain.then(async () => {
      if (failed) return;
      try {
        await bot.sendToolProgress({ accountId: msg.accountId, to: msg.fromUserId,
          contextToken: msg.contextToken, runId, timeoutMs: 3000, ...args });
      } catch (err) {
        failed = true;
        log.warn("tool progress unavailable for this reply", { err: err.name });
      }
    }).finally(() => { pending--; });
  }
  return {
    runId,
    onEvent(event) {
      if (finalized || !enabled) return;
      const id = event.toolUseId || event.id || event.tool_use_id;
      if (!id) return;
      if (event.type === "tool_use") {
        const name = event.toolName || event.name || "tool";
        if (failed || tools.has(id) || pending + tools.size + 2 > maxPending) return;
        tools.set(id, name);
        enqueue({ toolCallId: id, toolName: name });
      } else if (event.type === "tool_result") {
        const name = tools.get(id);
        if (!name) return;
        tools.delete(id);
        enqueue({ toolCallId: id, toolName: name, status: event.isError || event.is_error ? "failed" : "completed" });
      }
    },
    async finalize() { finalized = true; await chain; tools.clear(); },
  };
}
