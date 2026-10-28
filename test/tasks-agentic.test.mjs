import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentTrigger } from "../src/message-trigger.mjs";
import { createTasksAgenticConsole } from "../src/tasks-agentic.mjs";

const config = { allowFrom: ["owner"], groupTrigger: "prefix", triggerPrefix: "/" };
const message = (text = "", overrides = {}) => ({
  accountId: "bot-a", fromUserId: "owner", text, ...overrides,
});

// ---------------------------------------------------------------------------
// Trigger routing
// ---------------------------------------------------------------------------

test("allowlist is checked before every privileged or ordinary route", () => {
  for (const text of ["/p", "/p rm project", "/goal run tests", "/clear", "/tasks",
    "/tasks kill 1", "查看任务", "运行中的项目", "hello"]) {
    for (const groupId of [undefined, "group-a"]) {
      assert.deepEqual(parseAgentTrigger(message(text, { fromUserId: "stranger", groupId }), config),
        { action: "ignore" }, text);
    }
  }
});

test("four standalone entry commands enter; content uses only the active mode", () => {
  for (const kind of ['tasks', 'human', 'talk', 'auto']) {
    assert.deepEqual(parseAgentTrigger(message(`/${kind}`), config), { action: 'enter', mode: kind });
    const mode = { kind, sessionId: 'context' };
    assert.deepEqual(parseAgentTrigger(message('第一行\n第二行'), config, mode), { action: kind, prompt: '第一行\n第二行', modeSessionId: 'context' });
    assert.deepEqual(parseAgentTrigger(message(`${kind}/`), config, mode), { action: 'exit', mode: kind });
    assert.equal(parseAgentTrigger(message(`${kind}/`), config).action, 'invalid');
    assert.equal(parseAgentTrigger(message(`/${kind} 内容 ${kind}/`), config, mode).action, 'invalid');
  }
});

test("switching, duplicate entry and mismatched exits never change the active mode", () => {
  const mode = { kind: 'tasks', sessionId: 'context' };
  for (const text of ['/tasks', '/auto', 'talk/', 'human/', 'auto/']) {
    assert.equal(parseAgentTrigger(message(text), config, mode).action, 'invalid');
  }
  assert.equal(parseAgentTrigger(message('查看任务'), config).action, 'invalid');
});

test("quoted commands never become the sender's command", () => {
  assert.equal(parseAgentTrigger(message('/auto', { commandText: '' }), config).action, 'invalid');
  assert.equal(parseAgentTrigger(message('quoted', { commandText: '自己的问题', quoteContext: '/auto' }), config,
    { kind: 'talk', sessionId: 's' }).action, 'talk');
});

test("disabled groups stay silent; enabled groups have their own mode", () => {
  assert.equal(parseAgentTrigger(message('/tasks', { groupId: 'g' }), { ...config, groupTrigger: 'off' }).action, 'ignore');
  assert.equal(parseAgentTrigger(message('/tasks', { groupId: 'g' }), config).action, 'enter');
  assert.equal(parseAgentTrigger(message('查看任务', { groupId: 'g' }), config).action, 'invalid');
});

// ---------------------------------------------------------------------------
// Console bridge (fake native runtime)
// ---------------------------------------------------------------------------

function fixture({ resumed = true, rotated = false, consoleOptions = {} } = {}) {
  const calls = { turns: [], saves: [], disposes: 0, snapshots: [], sessionConfigs: [], listCalls: [],
    aliases: [], managerOptions: [], managerStarts: 0, managerStops: 0, launches: 0, serviceOptions: [] };
  const history = [{ role: "user", content: "早前消息" }];
  let blockTurn;
  const block = () => blockTurn;

  class FakeStore {
    constructor(scope, root) {
      calls.storeArgs = { scope, root };
      this.scopeId = "scope-x";
    }
    async use(run) {
      const meta = { sessionId: "00000000-0000-4000-8000-000000000001",
        expiresAt: 1_800_000_000_000, createdAt: 1_800_000_000_000 - 86_400_000,
        costUsd: 0.11, aliases: {} };
      const handle = {
        meta, resumed, rotated,
        messages: resumed ? structuredClone(history) : [],
        alias(target) {
          const id = `T${Object.keys(meta.aliases).length + 1}`;
          meta.aliases[id] = target;
          calls.aliases.push({ id, target });
          return id;
        },
        async save(messages, costUsd) {
          calls.saves.push({ count: messages.length, costUsd });
          meta.costUsd = Math.max(meta.costUsd, costUsd);
        },
      };
      return run(handle);
    }
  }

  class FakeService {
    constructor(options) {
      // The runtime scopes by TRUTHINESS: an empty-array workspaces option means
      // "zero workspaces" (no tasks, no studios) — it must never be sent.
      if (Array.isArray(options.workspaces) && options.workspaces.length === 0) {
        throw new Error("TaskControlService must not receive an empty workspaces array");
      }
      calls.serviceOptions.push(options);
    }
    async list(input) {
      calls.listCalls.push(input);
      return { snapshotId: "snap", total: 1, nextCursor: null,
        tasks: [{ target: { workspace: "/w/one", sessionId: "session-a" }, status: "parked", goal: "goal text" }] };
    }
  }

  class FakeSession {
    constructor(options) { calls.sessionConfigs.push(options); }
    setAppendSystemPrompt(value) { calls.snapshots.push(value); }
    async *submit(prompt) {
      calls.turns.push(prompt);
      if (blockTurn) await blockTurn;
      yield { type: "text", text: "第一段。" };
      yield { type: "tool_result", isError: true, content: "ignored" };
      yield { type: "text", text: "第二段。" };
    }
    getMessages() { return [...(resumed ? history : []), { role: "assistant", content: "ok" }]; }
    getEstimatedCost() { return 0.42; }
    interrupt() { calls.interrupts = (calls.interrupts ?? 0) + 1; }
    async dispose() { calls.disposes++; }
  }

  const runtime = {
    TasksAgenticSessionStore: FakeStore,
    TaskControlService: FakeService,
    createTaskOpsTools(service) { calls.toolsFor = service; return [{ name: "ops_tasks_list" }]; },
    AgenticSession: FakeSession,
    TaskManager: class {
      constructor(options) { calls.managerOptions.push(options); }
      async start() { calls.managerStarts++; }
      async stop() { calls.managerStops++; }
    },
    createSubprocessManagedWorkerLauncher(options) {
      calls.launchOptions = options;
      calls.launches++;
      return () => { throw new Error("No actual worker may launch in unit tests"); };
    },
  };

  const { env: extraEnv, ...restOptions } = consoleOptions;
  const console_ = createTasksAgenticConsole({
    bin: "/fake/meta-agent-glm",
    profile: "/test/glm_config.json",
    env: { META_AGENT_HOME: "/test/home", ...extraEnv },
    loadRuntime: async () => runtime,
    ...restOptions,
  });
  return { calls, console_, block(next) { blockTurn = next; } };
}

test("a turn mirrors the runtime console: snapshot aliases, save, dispose, joined reply", async () => {
  const f = fixture();
  const reply = await f.console_.turn("看下所有任务");
  assert.equal(f.calls.turns[0], "看下所有任务");
  // Session seeded with persisted history and the controller system prompt.
  assert.equal(f.calls.sessionConfigs[0].initialMessages.length, 1);
  assert.match(f.calls.sessionConfigs[0].systemPrompt, /task operations controller/);
  assert.equal(f.calls.sessionConfigs[0].initialCostUsd, 0.11);
  assert.equal(f.calls.sessionConfigs[0].maxTurns, 30);
  // Fresh alias-tagged snapshot appended for the model.
  assert.match(f.calls.snapshots[0], /Current fresh snapshot/);
  assert.match(f.calls.snapshots[0], /"alias":"T1"/);
  assert.equal(f.calls.aliases[0].target.sessionId, "session-a");
  // Messages + cost persisted, session disposed.
  assert.deepEqual(f.calls.saves[0], { count: 2, costUsd: 0.42 });
  assert.equal(f.calls.disposes, 1);
  assert.match(reply, /第一段。第二段。/);
  // Manager: single explicit-admission construction, no credentials forwarded.
  assert.equal(f.calls.managerStarts, 1);
  assert.equal(f.calls.managerOptions.length, 1);
  assert.equal(f.calls.managerOptions[0].explicitAdmission, true);
  assert.equal(f.calls.managerOptions[0].maxRunning, 3);
  assert.deepEqual(f.calls.launchOptions, { cli: {}, entryPath: "/fake/meta-agent-glm" });
  // The console lives in its own root, isolated from the terminal console.
  assert.equal(f.calls.storeArgs.root, "/test/home/task-ops/weixin");
  assert.equal(f.calls.serviceOptions[0].principal, "scope-x");
  // Regression: unset/empty scope must stay undefined, never an empty array.
  assert.equal(f.calls.serviceOptions[0].workspaces, undefined);
  assert.equal(f.calls.storeArgs.scope.workspaces, undefined);
});

test("an explicit workspaces scope flows through and empty values stay unscoped", async () => {
  const scoped = fixture({ consoleOptions: { workspaces: ["/w/one", "/w/two"] } });
  await scoped.console_.turn("查看任务");
  assert.deepEqual(scoped.calls.serviceOptions[0].workspaces, ["/w/one", "/w/two"]);

  const blank = fixture({ consoleOptions: { env: { META_AGENT_TASKS_WORKSPACES: " , " } } });
  await blank.console_.turn("查看任务");
  assert.equal(blank.calls.serviceOptions[0].workspaces, undefined);
});

test("a bare /tasks turn uses a sensible default prompt and announces the 24h session once", async () => {
  const f = fixture();
  const first = await f.console_.turn("");
  assert.match(f.calls.turns[0], /列出当前任务概览/);
  assert.match(first, /已续接 24 小时内的运维会话/);
  assert.match(first, /到期/);
  const second = await f.console_.turn("再看看");
  assert.doesNotMatch(second, /运维会话/);
});

test("a rotated expired session wipes history and the reply says so", async () => {
  const f = fixture({ resumed: false, rotated: true });
  const reply = await f.console_.turn("查看任务");
  assert.equal(f.calls.sessionConfigs[0].initialMessages.length, 0);
  assert.match(reply, /上次运维会话已超过 24 小时有效期/);
});

test("task operations never mutate the host model configuration", async t => {
  const previous = process.env.META_AGENT_CONFIG_FILE;
  delete process.env.META_AGENT_CONFIG_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.META_AGENT_CONFIG_FILE;
    else process.env.META_AGENT_CONFIG_FILE = previous;
  });
  const f = fixture();
  await f.console_.turn("查看任务");
  assert.equal(process.env.META_AGENT_CONFIG_FILE, undefined);
});

test("authorization auto-approves task run/steer and gates studio control", async () => {
  const f = fixture();
  await f.console_.turn("让它跑一轮");
  const authorize = f.calls.serviceOptions[0].authorize;
  await authorize({ capability: "ops.task.run" });
  await authorize({ capability: "ops.task.steer" });
  await assert.rejects(authorize({ capability: "ops.studio.control" }), /终端/);

  const permissive = fixture({ consoleOptions: { allowStudioControl: true } });
  await permissive.console_.turn("让它跑一轮");
  await permissive.calls.serviceOptions[0].authorize({ capability: "ops.studio.control" });
});

test("turns serialize on one console and never reject", async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.block(gate);
  const first = f.console_.turn("第一条");
  await new Promise(resolve => setImmediate(resolve));
  const second = f.console_.turn("第二条");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls.turns, ["第一条", "第二条"]);

  const failing = createTasksAgenticConsole({
    bin: "/missing/bin", profile: "/p.json",
    loadRuntime: async () => { throw new Error("runtime unavailable"); },
  });
  assert.match(await failing.turn("查看任务"), /❌[\s\S]*runtime unavailable/);
  await failing.close();
  assert.match(await failing.turn("x"), /已关闭/);
});

test("check is read-only: lists tasks without a manager, model session or store", async () => {
  const f = fixture();
  const text = await f.console_.check();
  assert.match(text, /任务读取正常/);
  assert.match(text, /session-a/);
  assert.equal(f.calls.managerStarts, 0);
  assert.equal(f.calls.sessionConfigs.length, 0);
  assert.equal(f.calls.storeArgs, undefined);
});

test("close stops the managed executor exactly once", async () => {
  const f = fixture();
  await f.console_.turn("查看任务");
  await f.console_.close();
  assert.equal(f.calls.managerStops, 1);
});
