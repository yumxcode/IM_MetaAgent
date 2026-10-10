# 微信 iLink Bot 接入层

一个**零框架依赖**的微信个人号 Bot 接入层，基于腾讯官方开放的 **iLink Bot API**（`ilinkai.weixin.qq.com`）。

- **`src/`（本文件所述）**：独立的纯 ESM JavaScript 接入层，可直接 `import` 使用。
- **`weixin-meta-agent.mjs`**：微信 ↔ meta-agent 桥接，在微信上远程调用本地 meta-agent 执行任务。
- **微信任务管理**：使用 `/tasks <自然语言>` 通过 `tasks --agentic` 运维对话查询和管理本机任务。
- **`packages/`**：腾讯官方插件代码（官方插件 2.4.9、安装器 2.1.4 的发布包参考副本，不作为 npm workspace）。


核对日期：**2026-10-06**。独立 `src/` 同步的是官方插件 2.4.9 中的协议行为，服务端兼容性仍以实际响应为准。官方插件当前声明支持**私聊**；保留的 `group_id` 与群聊路由配置是兼容数据处理，不代表已开放群聊接入。

---

## 能力清单

| 能力 | 说明 | 对应模块 |
|---|---|---|
| ✅ QR 码登录 | POST 获取二维码 → 数字配对码（需要时）→ 处理重定向/已绑定 → 持久化 token | `auth.mjs` |
| ✅ 多账号 | 同时管理多个微信账号，各自独立凭据/游标 | `auth.mjs` |
| ✅ 凭据持久化 | token / baseUrl / userId 存储到 `~/.weixin-bot/`，重启免登 | `auth.mjs` |
| ✅ 长轮询收消息 | getUpdates + 游标持久化 + 外部取消，重启可续接 | `poller.mjs` |
| ✅ 文本消息收发 | 入站解析（含引用 ID 无损处理/缓存还原、语音转文字）+ 出站（markdown 自动转纯文本） | `messaging.mjs` |
| ✅ 图片消息 | AES-128-ECB 加密 + CDN 上传/下载 + 自动解密 | `media.mjs` `crypto.mjs` |
| ✅ 语音消息 | 接收：SILK 解码为 WAV（可选 silk-wasm）及服务端转文字；发送：SILK V3 文件 | `media.mjs` |
| ✅ 文件消息 | 任意类型附件收发 | `media.mjs` |
| ✅ 视频消息 | 收发完整支持 | `media.mjs` |
| ✅ 流式回复 | message_state GENERATING → FINISH（打字机效果） | `messaging.mjs` |
| ✅ Typing 状态 | getConfig 缓存 + 周期续期 + 指数退避 | `typing.mjs` |
| ✅ Session 守护 | errcode=-14 自动暂停 1h，避免封禁 | `session-guard.mjs` |
| ✅ 错误恢复 | 连续失败退避、长轮询超时正常处理、游标防丢 | `poller.mjs` |
| ✅ 事件驱动 | `bot.on('message' \| 'image' \| 'voice' \| ...)` | `index.mjs` |
| ✅ context_token 管理 | 按账号和用户缓存入站 token，出站自动回填 | `messaging.mjs` |
| ✅ 运行通知/工具进度 | 启动、停止及工具执行进度消息 | `http.mjs` `messaging.mjs` |
| ✅ 新版媒体 URL | 服务端完整 URL 优先，保留加密参数兼容，正文读取限时及 100 MiB 明文大小限制 | `media.mjs` |

---

## 快速开始

### 环境要求
- Node.js **≥ 20.18**（使用内置 `fetch`、`crypto`、`AbortController`；与 `package.json` 的 `engines` 一致）
- 无需任何外部框架

### 安装

```bash
npm install
```

`npm install` 安装必需依赖 `dotenv`，并尝试安装以下可选依赖。官方参考包不参与根目录安装，不会因为 OpenClaw peer 依赖而安装整个 OpenClaw：

| 包 | 用途 | 缺失时行为 |
|---|---|---|
| `qrcode-terminal` | 终端渲染二维码（扫码登录） | 回退为打印二维码 URL，手动复制到浏览器扫码 |
| `silk-wasm` | SILK 语音解码为 WAV | 回退为保存原始 SILK 文件 |
| `@anthropic-ai/claude-agent-sdk` | 仅 Claude bridge demo 用 | demo 自动降级为回声模式 |

meta-agent runtime 使用独立安装，不参与 IM 依赖安装。GLM 任务运维对话（tasks --agentic）要求 runtime ≥ 0.11.3；服务器部署、更新和回滚见 [`INSTALL.md`](./INSTALL.md)。

### 用 CLI 跑通「登录 + 验证」（推荐，零代码）

仓库自带 `weixin-login-check.mjs`，**不依赖任何 AI / Claude**，专用于登录与连通性验证：

```bash
# 1) 扫码登录（首次必用；终端会打印二维码或二维码 URL）
npm run login

# 2) token 自检：对所有已登录账号探测 token 是否仍可用
npm run check

# 3) 列出已登录账号
npm run accounts

# 4) 进入回声监听：收到任何文本消息原样回复，验证完整收发链路（Ctrl+C 退出）
npm start          # 等价于 npm run listen

# 5) 注销某账号
npm run logout -- <accountId>
```

`npm run check` 使用短超时的 `getConfig` 查询检测账号，不消费微信消息，也不更改收信游标。查询成功才判定有效；超时表示状态未确认，`-14` 表示需要重新登录。

#### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `WEIXIN_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `WEIXIN_CHECK_TIMEOUT_MS` | `3000` | token 自检请求超时（毫秒） |
| `WEIXIN_STATE_DIR` | `~/.weixin-bot` | 覆盖状态目录根 |

建议放 `.env`，CLI 启动时自动加载。

### 最小示例（作为库使用）

```javascript
import { WeixinBot } from "./src/index.mjs";

const bot = new WeixinBot();

// 1. 扫码登录（首次）
await bot.login();

// 2. 订阅消息
bot.on("message", async (msg) => {
  console.log(`📩 ${msg.fromUserId}: ${msg.text}`);
  await bot.reply(msg, `你说的是：${msg.text}`);
});

// 3. 启动长轮询（阻塞）
await bot.start();
```

再次运行时无需扫码——凭据已持久化到 `~/.weixin-bot/weixin-bot/accounts/`（旧路径 `openclaw-weixin/` 启动时自动迁移）。

### 接入本地 Agent（meta-agent 桥接）

仓库自带 `weixin-meta-agent.mjs`，把**本地 meta-agent CLI**（[@meta-agent/runtime](https://github.com/yumxcode/meta_agent_runtime)）接入微信：在微信发消息 → 调用 meta-agent 执行 → 把输出以微信消息返回。

```bash
# 1. 确保 meta-agent CLI 已全局安装且 ~/.meta-agent/config.json 配好 API key
npm run agent:check        # 自检 CLI 可用 + 打印配置

# 2. 微信扫码登录（首次；复用与 login-check 相同的账号）
npm run agent:login

# 3. 开始监听
npm run agent
```

**触发规则**（默认）：
- **私聊**：所有文本消息触发 meta-agent
- 原有群聊前缀策略保留作为兼容配置；腾讯官方插件当前声明支持私聊

**配置**（环境变量，建议放 `.env`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_MODE` | `simple_auto` | 普通对话默认模式；`/goal <目标>` 使用完整 `auto` 自主模式 |
| `META_AGENT_MAX_TURNS` | `30` | 最大 agentic 轮数 |
| `META_AGENT_TIMEOUT_MS` | `0` | 单任务超时（毫秒），`0` 表示不限 |
| `META_AGENT_MAX_CONCURRENT` | `2` | 同时处理的微信 Agent 请求数 |
| `WEIXIN_TRIGGER_PREFIX` | `/` | 群聊触发前缀 |
| `WEIXIN_GROUP_TRIGGER` | `prefix` | 群聊策略：`off`/`prefix`/`all` |
| `WEIXIN_ALLOW_FROM` | (空) | 白名单 fromUserId，逗号分隔；留空=不限 |

使用 `/p new <名称>`、`/p clone <url> [名称]` 建立项目，用 `/p <名称>` 切换；每个项目有独立 workspace 和会话，无项目时自动创建临时项目。`/clear` 清除当前会话。

> **安全**：meta-agent 在 workspace 内可读写文件、执行 shell。确认项目目录中的文件允许 Agent 操作，并配置 `WEIXIN_ALLOW_FROM` 白名单；任务管理命令也遵循此白名单。

**实现原理**：spawn `meta-agent --json --yes "<prompt>"`，逐行解析 stdout 的 JSONL 事件流，累积 `text` 事件、捕获终止 `result` 事件，返回最终输出。核心封装在 `src/meta-agent-bridge.mjs`，可独立使用：

```javascript
import { runMetaAgent, checkMetaAgent } from "./src/meta-agent-bridge.mjs";

const r = await runMetaAgent("分析当前目录结构", {
  workspace: "/tmp/agent-workspace",
  mode: "agentic",
  maxTurns: 20,
  timeoutMs: 180_000,
  onText: (delta) => process.stdout.write(delta),  // 流式增量
});
// r = { ok, text, isError, subtype, durationMs, numTurns, costUsd, sessionId, ... }
console.log(r.ok ? r.text : `失败: ${r.subtype}`);
```

### 微信任务管理（tasks --agentic）

`/tasks <自然语言>` 桥接 runtime 的 `tasks --agentic` 运维控制台：一个运维模型带着任务快照和 ops 工具（list / inspect / run / steer 等）处理你的消息，支持多轮追问。它能查看从终端发起的任务，也能操作微信托管的任务，与 `/p` 项目池和普通对话会话分别管理。

任务后端需要 meta-agent runtime **≥ 0.11.3**。先运行 `npm run agent:tasks-check`，或 `node weixin-meta-agent.mjs --tasks-check`，只读检查后端版本与任务查询；此检查无需微信连接，也不调用模型。

#### 用法

```text
/tasks                          查看当前任务概览
/tasks 运行中的任务有哪些
/tasks 看下第 1 个任务的详情和最近日志
/tasks 让它立即跑一轮
/tasks 给它追加指令：先跑测试再提交
/tasks 上次运行的结果怎么样了
```

每轮回答前自动注入最新任务快照（带 T1/T2… 短别名，可直接说"让 T3 跑一轮"），任务用完整 session ID 定位。运行（`ops.task.run`）与纠偏（`ops.task.steer`）直接执行；**终止、删除、取消、Studio 生命周期**等高危操作默认不在微信侧授权，回复会指引到终端 `meta-agent-glm tasks --agentic` 确认执行（`META_AGENT_TASKS_ALLOW_STUDIO_CONTROL=true` 可放开 Studio 控制）。

私聊可直接发“查看任务”“任务列表”“运行中的项目”“运行中的任务”“最近进展 [任务]”或“查看进展 <任务>”。当前官方通道在私聊使用这些命令；原有群聊自然语言路由策略继续保留用于兼容。所有入口都先验证白名单；查询不占普通 Agent 请求的并发额度，自己的 Agent 正在运行时仍能查询。

托管执行器复用 runtime 的 TaskManager（显式准入：不会自动执行到期任务，只响应"让它跑一轮"这类请求），通过独立后台工作进程执行；工作进程读取自己的 provider 配置，不转发控制器密钥。单条消息默认最长 5 分钟（`META_AGENT_TASKS_TURN_TIMEOUT_MS`），超时中断并保存进度。

**运维会话存储时间**：运维对话固定 **24 小时**有效（runtime 硬编码）。过期后历史自动清空并新建会话，微信首次回复会提示已续接/已新建/已过期重建及到期时间；写操作回执持久保留。微信侧会话与终端控制台隔离存储（默认 `~/.meta-agent/task-ops/weixin`），互不抢占。

#### 后端配置

以下变量均为可选项，建议放 `.env`：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_TASKS_BIN` | `meta-agent-glm` | 后端命令或可执行文件路径 |
| `META_AGENT_TASKS_PROFILE` | `~/.meta-agent/glm_config.json` | 运维会话的模型配置（同时决定会话 scope） |
| `META_AGENT_TASKS_WORKSPACES` | 全部 | 逗号分隔的绝对路径，限定控制台可见工作区 |
| `META_AGENT_TASKS_MAX_TURNS` | `30` | 单轮运维对话的最大模型轮数 |
| `META_AGENT_TASKS_MAX_BUDGET_USD` | `10` | 运维会话累计费用上限（24 小时内） |
| `META_AGENT_TASKS_TURN_TIMEOUT_MS` | `300000` | 单条消息超时（毫秒），`0` 不限 |
| `META_AGENT_TASKS_MAX_RUNNING` | `3` | 托管执行器并发上限（1–64） |
| `META_AGENT_TASKS_OPS_ROOT` | `~/.meta-agent/task-ops/weixin` | 运维会话存储根目录 |
| `META_AGENT_TASKS_ALLOW_STUDIO_CONTROL` | `false` | 允许微信侧执行 Studio 生命周期操作 |
| `META_AGENT_TASKS_RUNTIME_DIR` | 自动发现 | 已安装的 runtime 根目录，用于加载运维能力 |

此配置只影响 `/tasks`，普通微信对话仍使用原来的 `meta-agent` CLI 和项目会话。

#### 与终端 tasks --agentic 的对应关系

两者共用 TaskControlService、ops 工具和操作回执；微信侧是"每条消息一轮"的对话形态，终端是交互式 REPL（另有 `r T2` / `s T1 <纠偏>` 快捷指令）。微信侧不提供终端的高危操作确认（kill / rm / cancel / Studio 生命周期请在终端执行）。

### 按消息类型分别处理

```javascript
bot.on("text", async (msg) => {
  await bot.reply(msg, `文本：${msg.text}`);
});

bot.on("image", async (msg) => {
  // msg.mediaPath 已自动下载解密到本地
  console.log(`图片已保存：${msg.mediaPath}`);
  await bot.reply(msg, "收到图片");
});

bot.on("voice", async (msg) => {
  // msg.voiceText 是微信服务端转写结果（若有）
  // msg.mediaPath 是解码后的 WAV（若 silk-wasm 可用）
  await bot.reply(msg, `语音：${msg.voiceText ?? "(无法转写)"}`);
});

bot.on("file", async (msg) => {
  await bot.reply(msg, `收到文件：${msg.fileName}`);
});

bot.on("video", async (msg) => {
  await bot.reply(msg, "收到视频");
});
```

### 发送媒体

```javascript
// 本地文件（按扩展名自动路由 image/video/file，.silk 走语音）
await bot.sendMedia({
  to: userId,
  mediaUrl: "/tmp/photo.png",       // 或 https://example.com/cat.jpg
  text: "一张图片",
  contextToken,                      // 可选，缺省自动从缓存取
});

// 显式类型
await bot.sendImageFile({ to: userId, filePath: "/tmp/a.png" });
await bot.sendVideoFile({ to: userId, filePath: "/tmp/v.mp4", text: "视频" });
await bot.sendFileAttachment({ to: userId, filePath: "/tmp/doc.pdf" });
```

### 流式回复（打字机效果）

```javascript
const stream = bot.createReplyStream({ to: userId, contextToken });
await stream.push("正在思考");      // 用户看到"正在生成"
await stream.push("正在思考...");   // 内容累加
await stream.finish("最终完整回复"); // FINISH，替换为最终内容
```

### Typing 指示

```javascript
const typing = await bot.typing({ to: userId, contextToken });
await typing.start();
// ... AI 生成中，用户看到"对方正在输入"
await typing.stop();
```

### 多账号

```javascript
const bot = new WeixinBot();

// 登录多个账号
await bot.login();  // 账号 A
// 扫码第二个账号：内部 startLogin/waitForLogin 两阶段，或
// 在另一进程登录后，listAccounts() 会看到所有账号

console.log(bot.listAccounts());  // ["aaa-im-bot", "bbb-im-bot"]

// 指定账号发送
await bot.sendText({ accountId: "bbb-im-bot", to: userId, text: "hi", contextToken });
```

---

## API 速查

### `WeixinBot` 类

#### 构造
```javascript
new WeixinBot({
  baseUrl?,        // 默认 https://ilinkai.weixin.qq.com
  cdnBaseUrl?,     // 默认 https://novac2c.cdn.weixin.qq.com/c2c
  routeTag?,       // SKRouteTag（企业路由，一般不用）
  inboundMediaDir?,// 入站媒体保存目录，默认 os.tmpdir()/weixin-bot/media/inbound
  autoDownloadMedia?, // 默认 true
})
```

#### 事件
| 事件 | 回调参数 | 触发时机 |
|---|---|---|
| `raw` | `(WeixinMessage, accountId)` | 收到任何原始消息（最早，未解析） |
| `message` | `(InboundMessage)` | 收到用户消息（已解析，媒体已下载） |
| `text` | `(InboundMessage)` | 纯文本消息 |
| `image` / `voice` / `file` / `video` | `(InboundMessage)` | 对应媒体消息 |
| `media` | `(InboundMessage)` | 任意媒体消息（含 `mediaPath`） |
| `error` | `(Error)` | 轮询/处理错误 |
| `session-expired` | `(accountId)` | 会话过期 |

#### `InboundMessage` 结构
```javascript
{
  raw,              // 原始 WeixinMessage
  accountId,
  fromUserId,       // 发送者（xxx@im.wechat）
  toUserId,
  contextToken,     // 回复时必须带上
  messageId, seq, createTimeMs, sessionId, groupId,
  messageType, messageState,
  text,             // 纯文本（已处理引用/语音转文字）
  mediaItem,        // 首个媒体 item（原始）
  itemTypes,        // 所有 item 类型
  // 以下字段在媒体下载后填充：
  mediaPath,        // 本地文件路径
  mediaType,        // MIME
  mediaBuffer,      // Buffer
  voiceText,        // 语音转文字（仅语音）
  fileName,         // 文件名（仅文件）
}
```

#### 方法
| 方法 | 说明 |
|---|---|
| `login(opts?)` | 扫码登录，凭据自动持久化 |
| `startLogin(opts)` / `waitForLogin(opts)` | 分段登录（Web 端展示二维码用） |
| `logout(accountId?)` | 删除账号凭据 |
| `start(opts?)` | 启动长轮询（阻塞） |
| `stop(accountId?)` | 停止轮询 |
| `sendText({to, text, contextToken?, accountId?})` | 发文本 |
| `sendMedia({to, mediaUrl, text?, ...})` | 发媒体（本地路径/http URL） |
| `sendImageFile/sendVideoFile/sendFileAttachment({to, filePath, text?})` | 显式类型 |
| `createReplyStream({to, contextToken})` | 流式回复 |
| `reply(msg, text)` | 快捷回复入站消息 |
| `replyWithMedia(msg, mediaUrl, text?)` | 快捷媒体回复 |
| `typing({to, contextToken})` | 返回 typing 控制器 |
| `listAccounts()` | 已登录账号列表 |
| `getAccountInfo(accountId?)` | 账号详情 |
| `isPaused(accountId?)` | 是否在 session 暂停期 |

### 进阶：直接使用子模块

所有子模块均具名导出，可按需引入：

```javascript
import {
  encryptAesEcb, decryptAesEcb,    // crypto.mjs
  uploadBufferToCdn,                // media.mjs
  getUpdates, sendMessage,          // http.mjs
  parseInbound,                     // messaging.mjs
  startPolling,                     // poller.mjs
  MessageType, MessageItemType,     // constants.mjs
} from "./src/index.mjs";
```

---

## 目录结构

```
src/
├── index.mjs          WeixinBot 主类 + 全部具名导出（入口）
├── constants.mjs      协议常量（MessageType / MessageItemType / 超时 / 错误码）
├── util.mjs           日志、脱敏、ID 生成、文件 IO、路径解析
├── crypto.mjs         AES-128-ECB 加解密 + PKCS7 padding
├── mime.mjs           MIME ↔ 扩展名映射
├── http.mjs           iLink HTTP 客户端 + 错误类 + 具体 API 封装
├── media.mjs          CDN 上传/下载 + 媒体管线 + SILK 解码
├── auth.mjs           QR 登录 + 凭据/游标持久化 + 多账号
├── messaging.mjs      消息构建/发送 + 入站解析 + contextToken 存储
├── typing.mjs         getConfig 缓存 + typing 控制器
├── poller.mjs         长轮询主循环 + 错误恢复
├── session-guard.mjs  Session 过期暂停
└── meta-agent-bridge.mjs  meta-agent CLI 桥接（spawn + JSONL 事件解析）
```

## 状态目录

```
~/.weixin-bot/weixin-bot/
├── accounts.json              账号 ID 索引
├── accounts/
│   ├── {accountId}.json       凭据（token/baseUrl/userId，0600）
│   └── {accountId}.sync.json  get_updates_buf 游标（0600）
└── meta-agent-sessions/       meta-agent 会话持久化（按微信账号分层）
    └── {wxAccountId}/
        ├── index.json
        └── {metaAgentSessionId}/history.jsonl
```

> 旧路径 `~/.weixin-bot/openclaw-weixin/` 启动时自动迁移到 `~/.weixin-bot/weixin-bot/`。
> 可通过 `WEIXIN_STATE_DIR` 环境变量覆盖状态目录根。

---

## 与 `packages/` 的关系

| 维度 | `src/`（本接入层） | `packages/`（官方插件） |
|---|---|---|
| 语言 | 纯 ESM JavaScript（无编译） | TypeScript（需 tsc） |
| 框架依赖 | 无 | OpenClaw >=2026.5.12，Node >=22.13.0 |
| 会话/路由/AI 编排 | 不含（由应用层决定） | 含（框架提供） |
| 协议依据 | 对齐 2.4.9 的 HTTP、登录、媒体、引用及通知能力 | 腾讯原始客户端实现 |
| 适用场景 | 自建 Bot、嵌入应用、最小依赖 | 使用该框架 Gateway 的用户 |

**选择建议**：
- 想完全自控、最小依赖、嵌入自己的服务 → 用 `src/`
- 需要现成的 AI Agent 编排 → 用 `packages/` 或搭配 `weixin-meta-agent.mjs`

---

## 合规说明

本接入层调用的是腾讯官方开放的 iLink Bot API，受《微信ClawBot功能使用条款》约束（见 `protocol.md`）。关键点：
- 腾讯仅提供消息通道，不存储内容、不提供 AI 服务
- 腾讯可随时限速、拦截、终止服务，**不应将核心业务完全依赖此 API**
- 禁止用于违法违规、绕过微信技术保护措施等行为

## 可选依赖

下表与 `package.json` 的 `optionalDependencies` 一一对应，`npm install` 会尝试安装，失败不阻断：

| 包 | 用途 | 缺失时行为 |
|---|---|---|
| `qrcode-terminal` | 终端渲染二维码（扫码登录） | 回退为打印二维码 URL |
| `silk-wasm` | SILK 语音解码为 WAV | 回退为保存原始 SILK 文件 |
| `@anthropic-ai/claude-agent-sdk` | 仅 Claude bridge demo 用 | demo 降级为回声模式 |
| `@meta-agent/runtime` | 本地任务后端 | 回退查找全局安装；完全缺失时提示安装 |

**必需依赖仅 `dotenv`**（用于 `.env` 加载）。所有可选依赖缺失时接入层核心功能不受影响。

## 升级与验证

本次从原有 1.0.2 协议接入同步到官方插件 2.4.9，保留现有账号、游标和 GLM 任务配置。根目录 `npm test` 执行独立桥接的协议和任务测试，`npm run build` 检查无需编译的 ESM 模块语法。官方包在 `packages/` 中保留发布内容及 LICENSE，版本分别为 2.4.9 和 2.1.4，不单独运行根目录的测试/构建。

首次重新登录时，如果微信要求输入数字配对码，交互终端会提示输入。无交互终端可在 `waitForLogin` 传入 `onVerifyCode` 回调，或收到 `requiresVerifyCode` 后使用同一 `sessionKey` 和 `verifyCode` 继续登录；不会一直阻塞等待不可用的标准输入。`binded_redirect` 表示已绑定，保留已有凭据并返回 `alreadyConnected`。

媒体下载使用新的对象形式，也兼容已有位置参数：

```javascript
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer, uploadVoice } from "./src/media.mjs";

const data = await downloadAndDecryptBuffer(message.file_item.media, {
  timeoutMs: 60_000, signal: controller.signal,
});
// 无 aes_key 的未加密媒体：
const plain = await downloadPlainCdnBuffer({ full_url: "https://example.com/media" });
// 出站语音仅接受包含 SILK V3 标头的编码内容，普通 mp3/wav 仍作为文件发送：
const uploaded = await uploadVoice({ filePath: "/tmp/audio.silk", toUserId, opts: { baseUrl, token } });
```

`CDNMedia.full_url` 优先于 `encrypt_query_param`；上传优先使用 `upload_full_url`，不追加或重写已签名的参数。明文最大 100 MiB，密文允许 PKCS7 填充额外空间，解密后仍核对明文大小。超时覆盖获取响应及完整正文读取，取消后中止网络请求；签名 URL、响应正文和密钥不输出到媒体错误日志。

源码与字段说明见 [本项目协议说明](./weixin-bot-api.md)、[腾讯官方协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) 和 [腾讯官方变更日志](https://github.com/Tencent/openclaw-weixin/blob/main/CHANGELOG.zh_CN.md)。

独立接入层支持 Node.js 20.18 及以上。Node 20 缺少内置 SQLite，历史引用缓存自动关闭；微信收发、媒体及任务功能继续运行，消息中直接携带的引用文本仍可解析。Node.js 22.13 及以上可使用内置 SQLite 引用缓存。缓存默认保留文本 30 天、每账号 10,000 条，媒体 7 天、每账号 256 MiB、单文件 25 MiB。设置 `WEIXIN_QUOTE_CACHE_ENABLED=false` 可关闭，或在 `new WeixinBot({ quoteCache: { enabled: false } })` 中配置；SQLite 不可用时记录提示并继续接收消息。缓存引用只补充 Agent 上下文，任务指令始终按当前用户消息解析。

`bot.sendVoiceFile({ to, filePath, contextToken })` 发送本地 SILK V3 文件。`bot.sendToolProgress({ to, toolName, toolCallId, status, runId, contextToken })` 发送官方工具进度：省略 `status` 表示开始，`completed` / `failed` 表示结束。主桥接会自动把工具事件和最终回复关联到相同 `run_id`，设置 `WEIXIN_REPLY_PROGRESS_MESSAGES=false` 可关闭工具进度。

服务退出时通知 iLink 停止接收，并停止任务管理器接收新任务；已启动的托管任务按原有后台运行方式继续。

多账号默认选择最近一次保存登录凭据的账号，可用 `WEIXIN_ACCOUNT_ID` 或 `bot.setDefaultAccount(id)` 固定指定账号。若扫码返回新的机器人账号 ID，需要重启常驻服务切换账号；同账号 token 刷新会在暂停期间每 5 秒自动检查。
