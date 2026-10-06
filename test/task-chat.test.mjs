import test from "node:test";
import assert from "node:assert/strict";
import { createTaskChat, parseTaskCommand } from "../src/task-chat.mjs";
import { parseAgentTrigger } from "../src/message-trigger.mjs";

const config = { allowFrom: ["owner"], groupTrigger: "prefix", triggerPrefix: "/" };
const message = (text = "", overrides = {}) => ({
  accountId: "bot-a", fromUserId: "owner", text, ...overrides,
});
const task = (sessionId, overrides = {}) => ({
  sessionId, workspace: `/projects/${sessionId}`, status: "parked", updatedAt: 100,
  goal: `goal ${sessionId}`, note: `note ${sessionId}`, progress: {}, wake: { wakeId: `wake-${sessionId}` }, ...overrides,
});

function fixture(initialTasks = [task("session-a")]) {
  let tasks = initialTasks;
  let time = 10_000;
  let count = 0;
  const calls = [];
  const backend = {
    async list() { calls.push(["list"]); return structuredClone(tasks); },
    async activity(value, options) {
      calls.push(["activity", value.sessionId, options]);
      return { entries: [], report: null };
    },
    async action(value, kind, text, options) {
      calls.push(["action", value.sessionId, value.workspace, kind, text, options]);
      return { ok: true, message: "applied" };
    },
    managerStatus() {
      calls.push(["status"]);
      return { enabled: false, running: 0, queued: 2, maxRunning: 3 };
    },
    async startManaging(max) { calls.push(["start", max]); return { message: "started" }; },
    async stopManaging() { calls.push(["stop"]); return { message: "stopped" }; },
  };
  const chat = createTaskChat({ backend, now: () => time, token: () => `token-${++count}` });
  return {
    backend, calls,
    setTasks(value) { tasks = value; },
    setTime(value) { time = value; },
    async send(text, msg = message()) {
      const request = parseTaskCommand(text);
      assert.ok(request, `Expected task command: ${text}`);
      return chat.handle(msg, request);
    },
  };
}

const actions = f => f.calls.filter(call => call[0] === "action");
const confirmation = response => {
  const match = response.match(/\/tasks confirm (\S+)/);
  assert.ok(match, response);
  return match[1];
};

test("allowlist is checked before every privileged or ordinary route", () => {
  for (const text of ["/p", "/p rm project", "/goal run tests", "/clear", "/tasks",
    "/tasks kill 1", "/tasks confirm token", "查看任务", "运行中的项目", "hello"]) {
    for (const groupId of [undefined, "group-a"]) {
      assert.deepEqual(parseAgentTrigger(message(text, { fromUserId: "stranger", groupId }), config),
        { action: "ignore" }, text);
    }
  }
});

test("authorized explicit task routes work in groups, including group policy off", () => {
  for (const groupTrigger of ["off", "prefix", "all"]) {
    const result = parseAgentTrigger(message("/tasks running", { groupId: "group-a" }),
      { ...config, groupTrigger, triggerPrefix: "!" });
    assert.equal(result.action, "tasks");
    assert.equal(result.request.command, "running");
  }
  assert.equal(parseAgentTrigger(message("/p list"), config).action, "project");
  assert.equal(parseAgentTrigger(message("/goal build it"), config).action, "goal");
  assert.equal(parseAgentTrigger(message("/clear"), config).action, "clear");
});

test("natural aliases in groups obey prefix, mention stripping, all, and off", () => {
  const group = text => message(text, { groupId: "group-a" });
  assert.equal(parseAgentTrigger(group("查看任务"), config).action, "ignore");
  assert.equal(parseAgentTrigger(group("/查看任务"), config).request.command, "list");
  assert.equal(parseAgentTrigger(group("/@bot 运行中的项目"), config).request.command, "running");
  assert.equal(parseAgentTrigger(group("!最近进展 session-a"), { ...config, triggerPrefix: "!" }).request.selector, "session-a");
  assert.equal(parseAgentTrigger(group("最近进展"), { ...config, groupTrigger: "all" }).request.command, "recent");
  assert.equal(parseAgentTrigger(group("/查看任务"), { ...config, groupTrigger: "off" }).action, "ignore");
  assert.equal(parseAgentTrigger(group("查看进展 session-a"), { ...config, groupTrigger: "off" }).action, "ignore");
});

test("private aliases require a complete request and preserve selectors", () => {
  const expected = [["查看任务", "list"], ["任务列表", "list"], ["运行中的任务", "running"],
    ["最近进展", "recent"], ["最近进展 session-a", "progress"], ["查看进展 session-a", "progress"]];
  for (const [text, command] of expected) {
    assert.equal(parseAgentTrigger(message(text), config).request.command, command);
  }
  assert.equal(parseAgentTrigger(message("请查看任务然后写总结"), config).action, "respond");
  assert.equal(parseTaskCommand("/tasks-other"), null);
  assert.equal(parseTaskCommand("tasks"), null);
  assert.equal(parseTaskCommand("/tasks --manage").command, "manage");
});

test("list selectors refer to saved full identity after the backend reorders tasks", async () => {
  const a = task("session-a", { updatedAt: 10 });
  const b = task("session-b", { updatedAt: 20 });
  const f = fixture([a, b]);
  assert.match(await f.send("/tasks"), /1\. session-b/);
  f.setTasks([{ ...a, updatedAt: 40 }, { ...b, updatedAt: 30 }]);
  const shown = await f.send("/tasks show 1");
  assert.match(shown, /session-b · session-b/);
  assert.doesNotMatch(shown, /goal session-a/);
  assert.equal(actions(f).length, 0);
  assert.equal(f.calls.filter(call => call[0] === "start").length, 0);
});

test("recent snapshots are capped and selectors are scoped to account, sender and group", async () => {
  const tasks = Array.from({ length: 7 }, (_, i) => task(`session-${i}`, { updatedAt: i }));
  const f = fixture(tasks);
  assert.match(await f.send("/tasks recent"), /5\/7/);
  f.setTasks(tasks.map(t => ({ ...t, updatedAt: 100 - t.updatedAt })));
  assert.match(await f.send("/tasks show 1"), /session-6 · session-6/);
  assert.match(await f.send("/tasks show 6"), /序号不在上次任务列表内/);
  for (const changed of [{ accountId: "bot-b" }, { fromUserId: "someone" }, { groupId: "group-a" }]) {
    assert.match(await f.send("/tasks show 1", message("", changed)), /序号不在上次任务列表内/);
  }
});

test("a disappeared snapshot identity cannot select its replacement with the same prefix", async () => {
  const f = fixture([task("session-a-full")]);
  await f.send("/tasks");
  f.setTasks([task("session-a-replacement", { workspace: "/projects/session-a-full" })]);
  assert.match(await f.send("/tasks show 1"), /未找到任务/);
});

test("ambiguous project names and session prefixes reject mutations", async () => {
  const f = fixture([
    task("shared-a", { workspace: "/one/project" }),
    task("shared-b", { workspace: "/two/project" }),
  ]);
  for (const selector of ["project", "shared-"]) {
    assert.match(await f.send(`/tasks cancel ${selector}`), /匹配到 2 个任务/);
  }
  assert.equal(actions(f).length, 0);
  assert.match(await f.send("/tasks cancel shared-a"), /✅/);
  assert.equal(actions(f)[0][1], "shared-a");
  assert.equal(actions(f)[0][2], "/one/project");
});

test("confirmed termination is scoped to bot account, sender and group, then consumed", async () => {
  const f = fixture([task("session-a", { status: "running" })]);
  const code = confirmation(await f.send("/tasks kill session-a"));
  assert.equal(actions(f).length, 0);
  for (const changed of [{ accountId: "bot-b" }, { fromUserId: "someone" }, { groupId: "group-a" }]) {
    assert.match(await f.send(`/tasks confirm ${code}`, message("", changed)), /确认码无效或已过期/);
  }
  assert.match(await f.send(`/tasks confirm ${code}`), /✅/);
  assert.deepEqual(actions(f)[0].slice(1), ["session-a", "/projects/session-a", "kill", "", { confirmed: true, expectedWakeId: "wake-session-a" }]);
  assert.match(await f.send(`/tasks confirm ${code}`), /确认码无效或已过期/);
  assert.equal(actions(f).length, 1);
});

test("confirmation expires at the 60-second boundary", async () => {
  const f = fixture([task("session-a", { status: "finished" })]);
  const code = confirmation(await f.send("/tasks rm session-a"));
  f.setTime(70_000);
  assert.match(await f.send(`/tasks confirm ${code}`), /确认码无效或已过期/);
  assert.equal(actions(f).length, 0);
});

test("confirmation stores the full session and workspace identity", async () => {
  for (const replacement of [
    task("session-a-other", { workspace: "/projects/session-a-original", status: "finished" }),
    task("session-a-original", { workspace: "/other/project", status: "finished" }),
  ]) {
    const f = fixture([task("session-a-original", { status: "finished" })]);
    const code = confirmation(await f.send("/tasks rm session-a"));
    f.setTasks([replacement]);
    assert.match(await f.send(`/tasks confirm ${code}`), /任务已不存在/);
    assert.equal(actions(f).length, 0);
  }
});

test("confirmation revalidates changed execution state before deletion or termination", async () => {
  const deleting = fixture([task("session-a", { status: "finished" })]);
  const deletionCode = confirmation(await deleting.send("/tasks rm session-a"));
  deleting.setTasks([task("session-a", { status: "running" })]);
  assert.match(await deleting.send(`/tasks confirm ${deletionCode}`), /任务正在执行/);
  assert.equal(actions(deleting).length, 0);

  const killing = fixture([task("session-a", { status: "running" })]);
  const killCode = confirmation(await killing.send("/tasks kill session-a"));
  killing.setTasks([task("session-a", { status: "finished" })]);
  assert.match(await killing.send(`/tasks confirm ${killCode}`), /没有正在执行的轮次/);
  assert.equal(actions(killing).length, 0);
});

test("steering preserves multiline free text and literal --text content", async () => {
  const f = fixture();
  const text = '--text "use this exact phrase"\n保留  两个空格\n然后完成测试';
  assert.match(await f.send(`/tasks steer session-a ${text}`), /✅/);
  assert.equal(actions(f)[0][4], text);
  assert.match(await f.send("/tasks steer session-a"), /用法/);
  assert.equal(actions(f).length, 1);
});

test("kill confirmation cannot terminate a replacement running round of the same task", async () => {
  const f = fixture([task("session-a", { status: "running", wake: { wakeId: "round-a" } })]);
  const code = confirmation(await f.send("/tasks kill session-a"));
  f.setTasks([task("session-a", { status: "running", wake: { wakeId: "round-b" } })]);
  assert.match(await f.send(`/tasks confirm ${code}`), /任务执行轮次已改变/);
  assert.equal(actions(f).length, 0);
  assert.match(await f.send(`/tasks confirm ${code}`), /确认码无效或已过期/);
});

test("manager status is read-only and invalid start counts never start admission", async () => {
  const f = fixture();
  for (const input of ["/tasks manage", "/tasks manage status"]) {
    assert.match(await f.send(input), /未启动/);
  }
  for (const value of ["0", "-1", "1.5", "abc", "Infinity", "9007199254740992", "2 extra"]) {
    assert.match(await f.send(`/tasks manage start ${value}`), /并发数必须为正整数/);
  }
  assert.equal(f.calls.filter(call => call[0] === "start").length, 0);
  assert.match(await f.send("/tasks manage start"), /started/);
  assert.match(await f.send("/tasks manage start 2"), /started/);
  assert.deepEqual(f.calls.filter(call => call[0] === "start"), [["start", 3], ["start", 2]]);
  assert.match(await f.send("/tasks manage stop"), /stopped/);
});

test("backend failures and declined actions return chat errors without rejecting", async () => {
  const f = fixture();
  f.backend.list = async () => { throw new Error("task store unavailable"); };
  assert.match(await f.send("/tasks"), /❌ 任务操作失败: task store unavailable/);
  f.backend.list = async () => [task("session-a")];
  f.backend.action = async () => ({ ok: false, message: "cannot run finished task" });
  assert.match(await f.send("/tasks run-now session-a"), /❌[\s\S]*cannot run finished task/);
  f.backend.activity = async () => ({ error: "no readable activity" });
  assert.match(await f.send("/tasks logs session-a"), /活动读取失败: no readable activity/);
});

test("progress, logs, reports and artifacts only describe existing records", async () => {
  const f = fixture([task("session-a", { progress: { artifacts: ["out/report.md"] } })]);
  assert.match(await f.send("/tasks progress session-a"), /暂无可读取的管理器活动日志/);
  assert.match(await f.send("/tasks report session-a"), /暂无此轮完成报告/);
  assert.deepEqual(f.calls.filter(call => call[0] === "activity").map(call => call[2]),
    [{ reportOnly: false }, { reportOnly: true }]);
  assert.match(await f.send("/tasks artifacts session-a"), /out\/report\.md/);
  f.backend.activity = async () => ({ entries: Array.from({ length: 4 }, (_, i) => ({ kind: "agent", text: `entry-${i}` })) });
  const logs = await f.send("/tasks logs session-a 2");
  assert.match(logs, /entry-2[\s\S]*entry-3/);
  assert.doesNotMatch(logs, /entry-0|entry-1/);
  for (const value of ["0", "31", "NaN", "1 extra"]) {
    assert.match(await f.send(`/tasks logs session-a ${value}`), /活动条数应在 1–30/);
  }
});

test("mutations serialize while read queries remain available", async () => {
  const f = fixture();
  let release;
  let announce;
  const entered = new Promise(resolve => { announce = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const completed = [];
  f.backend.action = async (_value, kind) => {
    completed.push(`start:${kind}`);
    if (kind === "steer") { announce(); await blocked; }
    completed.push(`end:${kind}`);
    return { ok: true, message: "applied" };
  };
  const first = f.send("/tasks steer session-a wait for this");
  await entered;
  const second = f.send("/tasks cancel session-a");
  assert.match(await f.send("/tasks show session-a"), /goal session-a/);
  assert.deepEqual(completed, ["start:steer"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(completed, ["start:steer", "end:steer", "start:cancel", "end:cancel"]);
});

test("numeric read selectors are captured before an asynchronous backend list", async () => {
  const a = task("session-a", { updatedAt: 20 });
  const b = task("session-b", { updatedAt: 10 });
  const f = fixture([a, b]);
  await f.send("/tasks");
  let release;
  const listed = new Promise(resolve => { release = resolve; });
  f.backend.list = async () => listed;
  const pendingRead = f.send("/tasks show 1");
  const reordered = [{ ...a, updatedAt: 10 }, { ...b, updatedAt: 20 }];
  f.backend.list = async () => reordered;
  await f.send("/tasks recent");
  release(reordered);
  assert.match(await pendingRead, /session-a · session-a/);
  assert.match(await f.send("/tasks show 1"), /session-b · session-b/);
});

test("queued numeric and selected mutations keep the target from message receipt", async () => {
  for (const selector of ["1", ""]) {
    const a = task("session-a", { updatedAt: 20 });
    const b = task("session-b", { updatedAt: 10 });
    const f = fixture([a, b]);
    await f.send("/tasks");
    await f.send("/tasks show session-a");
    let release;
    let announce;
    const entered = new Promise(resolve => { announce = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    f.backend.action = async (value, kind, text, options) => {
      f.calls.push(["action", value.sessionId, value.workspace, kind, text, options]);
      if (kind === "steer") { announce(); await blocked; }
      return { ok: true, message: "applied" };
    };
    const first = f.send("/tasks steer session-a hold this action");
    await entered;
    const queued = f.send(`/tasks cancel ${selector}`);
    f.setTasks([{ ...a, updatedAt: 10 }, { ...b, updatedAt: 20 }]);
    await f.send("/tasks recent");
    await f.send("/tasks show session-b");
    release();
    await Promise.all([first, queued]);
    assert.equal(actions(f).at(-1)[1], "session-a", selector || "selected");
  }
});
