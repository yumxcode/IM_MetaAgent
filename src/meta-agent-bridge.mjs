/**
 * meta-agent 桥接模块 —— 把本地 meta-agent CLI 当作"任务执行后端"
 *
 * 设计：spawn `meta-agent --json --yes "<prompt>"`，逐行解析 stdout 的 JSONL 事件，
 * 累积 text 事件、捕获终止 result 事件，返回最终输出。
 *
 * 选择 CLI 子进程而非 SDK 嵌入的理由：
 *  - 进程隔离：meta-agent 跑飞（死循环/OOM）不影响调用方
 *  - 零耦合：不把 @meta-agent/runtime 装进本项目；meta-agent 自己读 ~/.meta-agent/config.json 解析 API key
 *  - 稳定契约：JSONL 事件流是跨版本的稳定接口
 *
 * 事件类型（v0.3.3，节选）：
 *   text      → { type:'text', text, sessionId }              增量答案文本
 *   tool_use  → { type:'tool_use', toolName, toolInput, ... } 工具调用
 *   tool_result → { type:'tool_result', content, isError, ... }
 *   result    → { type:'result', subtype, result, isError, durationMs, numTurns, totalCostUsd, usage, errors }
 *               subtype ∈ success | error_max_turns | error_max_budget | error_during_execution
 *               result 事件总是 submit() 的终止事件
 *
 * 参考：.meta-agent/research/subtask-3967f517/report.md
 */
import { spawn } from "node:child_process";

/**
 * 默认超时。
 * 0 = 不限制（推荐）。meta-agent 自身有完善的执行限制：
 *   - 主循环 turn 上限：默认 100（--max-turns）
 *   - 单个 tool 超时：180s（META_AGENT_TOOL_TIMEOUT_MS）
 *   - auto 模式 wall-clock：2h
 * bridge 不应额外加一道总超时去杀正常执行中的 meta-agent。
 * 仅在需要兜底防护（防僵尸进程）时通过 timeoutMs 显式设置。
 */
const DEFAULT_TIMEOUT_MS = 0;

/**
 * 解析 meta-agent 可执行文件名（跨平台）。
 * npm 全局安装后 PATH 里会有 `meta-agent`；Windows 是 `meta-agent.cmd`。
 */
export function resolveMetaAgentBin() {
  return process.platform === "win32" ? "meta-agent.cmd" : "meta-agent";
}

/**
 * 自检 meta-agent CLI 是否可用。
 * @returns {Promise<{ok:boolean, version?:string, reason?:string, code?:number}>}
 */
export function checkMetaAgent() {
  return new Promise((resolve) => {
    const child = spawn(resolveMetaAgentBin(), ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", (err) =>
      resolve({ ok: false, reason: err.code === "ENOENT" ? "not_found" : String(err) })
    );
    child.on("close", (code) => resolve({ ok: code === 0, version: out.trim(), code }));
  });
}

/**
 * 运行 meta-agent 执行一个任务，返回最终输出。
 *
 * @param {string} prompt - 任务文本（作为 CLI positional 参数）
 * @param {object} [opts]
 * @param {string} [opts.workspace=process.cwd()] - meta-agent 工作目录（agent 只在该目录内操作）
 * @param {string} [opts.mode='auto'] - detect|agentic|auto|campaign|robotics
 *        ⚠️ 'auto' 是自主模式（workspace 内写操作自动批准），适合微信无人值守场景
 * @param {number} [opts.maxTurns=30] - 最大 agentic 轮数
 * @param {number} [opts.timeoutMs=0] - 整体超时（0=不限，信任 meta-agent 自身的 turns/tool 限制）；>0 时超时后 SIGTERM/SIGKILL
 * @param {string} [opts.systemPrompt] - 自定义 system prompt（透传 --system）
 * @param {string[]} [opts.extraArgs] - 额外 CLI 参数
 * @param {string} [opts.resumeSessionId] - 复用已有会话（透传 --resume <id>）；不传则开新 session
 * @param {string} [opts.sessionDir] - one-shot session 持久化目录（透传 --session-dir <dir>）；传入则 meta-agent 执行后落盘 history，供下次 --resume
 * @param {(delta:string)=>void} [opts.onText] - 流式文本回调（每个 text 事件的增量）
 * @param {(event:object)=>void} [opts.onEvent] - 任意事件回调（调试用）
 * @returns {Promise<MetaAgentRunResult>}
 *
 * @typedef {Object} MetaAgentRunResult
 * @property {boolean} ok - 任务是否成功（基于 result.isError）
 * @property {string} text - 最终答案文本（优先 result.result，回退累积 text）
 * @property {boolean} isError
 * @property {string} subtype - success | error_max_turns | error_max_budget | error_during_execution | timeout | spawn_failed | agent_crashed | no_result
 * @property {string} [result] - 与 text 同义（原始 result.result）
 * @property {number} [durationMs]
 * @property {number} [numTurns]
 * @property {number} [costUsd]
 * @property {string} [sessionId]
 * @property {string[]} [errors]
 * @property {string} stderr - 子进程 stderr（诊断信息，调试用）
 * @property {number} [exitCode]
 * @property {boolean} [timeout]
 */
export async function runMetaAgent(prompt, opts = {}) {
  const {
    workspace = process.cwd(),
    mode = "auto",
    maxTurns = 30,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    systemPrompt,
    extraArgs = [],
    resumeSessionId,
    sessionDir,
    onText,
    onEvent,
  } = opts;

  // 1. 参数校验
  if (!prompt || !String(prompt).trim()) {
    return {
      ok: false, isError: true, subtype: "empty_prompt",
      text: "", errors: ["empty prompt"], stderr: "",
    };
  }

  // 2. 构造 CLI 参数
  const args = [
    "--json", "--yes", // JSONL 事件流 + 跳过交互确认（非 TTY 本来就不确认，双保险）
    "--mode", mode,
    "--max-turns", String(maxTurns),
  ];
  if (workspace) args.push("--workspace", workspace);
  if (systemPrompt) args.push("--system", systemPrompt);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (sessionDir) args.push("--session-dir", sessionDir);
  args.push(...extraArgs);
  args.push(prompt); // positional prompt → 一次性执行后退出

  // 3. spawn
  return new Promise((resolve) => {
    let child;
    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let textAccum = "";
    let resultEvent = null;
    let timer = null;
    let timedOut = false;

    const settle = (patch = {}) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      const baseText = resultEvent?.result ?? textAccum;
      const isError =
        patch.isError ??
        (resultEvent ? Boolean(resultEvent.isError) : !patch.ok);
      resolve({
        ok: patch.ok ?? (!isError && !timedOut),
        text: patch.text ?? baseText,
        isError,
        subtype: patch.subtype ?? resultEvent?.subtype ?? (timedOut ? "timeout" : "no_result"),
        result: baseText,
        durationMs: resultEvent?.durationMs,
        numTurns: resultEvent?.numTurns,
        costUsd: resultEvent?.totalCostUsd,
        sessionId: resultEvent?.sessionId,
        errors: patch.errors ?? resultEvent?.errors,
        stderr: stderrBuf,
        timeout: timedOut || undefined,
        ...patch,
      });
    };

    try {
      child = spawn(resolveMetaAgentBin(), args, {
        cwd: workspace || undefined,
        env: process.env, // 继承环境（含 meta-agent 的 API key / config 路径）
        stdio: ["ignore", "pipe", "pipe"], // stdin 不需要（--yes 跳过交互）
      });
    } catch (err) {
      settle({
        ok: false, isError: true, subtype: "spawn_failed", text: "",
        errors: [err.code === "ENOENT"
          ? "meta-agent 命令未找到。请先安装: npm install -g @meta-agent/runtime"
          : String(err)],
      });
      return;
    }

    // 4. 超时保护（仅 timeoutMs > 0 时生效；默认 0 = 不限制，信任 meta-agent 自身的 turns/tool 限制）
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (!child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => {
            try { if (!child.killed) child.kill("SIGKILL"); } catch {}
          }, 3000);
        }
        settle({ ok: false, isError: true, subtype: "timeout", text: textAccum });
      }, Math.max(timeoutMs, 1000));
    }

    // 5. spawn 失败（异步 ENOENT 等）
    child.on("error", (err) => {
      settle({
        ok: false, isError: true, subtype: "spawn_failed", text: "",
        errors: [err.code === "ENOENT"
          ? "meta-agent 命令未找到。请先安装: npm install -g @meta-agent/runtime"
          : `${err.code ?? ""} ${err.message}`],
      });
    });

    // 6. 解析 stdout JSONL
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // 跳过非 JSON 行（理论上 --json 模式不会出现）
        }
        onEvent?.(ev);
        if (ev.type === "text" && typeof ev.text === "string") {
          textAccum += ev.text;
          onText?.(ev.text);
        } else if (ev.type === "result") {
          resultEvent = ev;
        }
      }
    });

    // 7. 收集 stderr（诊断/错误，不解析）
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderrBuf += d));

    // 8. 进程结束
    child.on("close", (code) => {
      if (resultEvent) {
        settle({ exitCode: code });
      } else {
        // 无 result 事件：meta-agent 异常退出（缺 API key / 参数错误 / 启动失败）
        settle({
          ok: false,
          isError: true,
          subtype: timedOut ? "timeout" : (code === 0 ? "no_result" : "agent_crashed"),
          text: textAccum,
          exitCode: code,
          errors: timedOut ? undefined : [
            stderrBuf.trim() || `meta-agent exited with code ${code} without a result event`,
          ],
        });
      }
    });
  });
}
