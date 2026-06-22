import { runMetaAgent } from "./src/meta-agent-bridge.mjs";

console.log("--- 第1轮（新 session）---");
const r1 = await runMetaAgent("记住这个数字：42。只回复 OK", {
  timeoutMs: 60_000, maxTurns: 3,
});
console.log("  ok:", r1.ok, "| session:", r1.sessionId?.slice(0, 12), "| text:", JSON.stringify(r1.text?.slice(0, 40)));

if (!r1.sessionId) { console.log("❌ 无 sessionId"); process.exit(1); }

console.log("--- 第2轮（resume 同 session，验证记忆）---");
const r2 = await runMetaAgent("我刚才让你记住的数字是多少？只回复数字", {
  timeoutMs: 60_000, maxTurns: 3,
  resumeSessionId: r1.sessionId,
});
console.log("  ok:", r2.ok, "| session:", r2.sessionId?.slice(0, 12), "| text:", JSON.stringify(r2.text?.slice(0, 40)));
console.log("  同一session?", r1.sessionId === r2.sessionId ? "✅" : "❌");
console.log("  记住了42?", r2.text?.includes("42") ? "✅ 上下文复用成功" : "⚠️ 回复：" + r2.text?.slice(0, 60));
process.exit(0);
