# 微信 iLink Bot 接入层

一个**完备的、零框架依赖**的微信个人号 Bot 接入层，基于腾讯官方开放的 **iLink Bot API**（`ilinkai.weixin.qq.com`）。

- **`src/`（本文件所述）**：独立的纯 ESM JavaScript 接入层，可直接 `import` 使用。
- **`weixin-meta-agent.mjs`**：微信 ↔ meta-agent 桥接，在微信上远程调用本地 meta-agent 执行任务。
- **`packages/`**：腾讯官方插件代码（参考用，非本项目维护重点）。

---

## 能力清单

| 能力 | 说明 | 对应模块 |
|---|---|---|
| ✅ QR 码登录 | 扫码 → 长轮询状态 → 自动刷新过期码 → 持久化 token | `auth.mjs` |
| ✅ 多账号 | 同时管理多个微信账号，各自独立凭据/游标 | `auth.mjs` |
| ✅ 凭据持久化 | token / baseUrl / userId 存储到 `~/.weixin-bot/`，重启免登 | `auth.mjs` |
| ✅ 长轮询收消息 | getUpdates + 游标持久化，重启可续接 | `poller.mjs` |
| ✅ 文本消息收发 | 入站解析（含引用、语音转文字）+ 出站（markdown 自动转纯文本） | `messaging.mjs` |
| ✅ 图片消息 | AES-128-ECB 加密 + CDN 上传/下载 + 自动解密 | `media.mjs` `crypto.mjs` |
| ✅ 语音消息 | SILK 解码为 WAV（可选依赖 silk-wasm）+ 协议自带转文字 | `media.mjs` |
| ✅ 文件消息 | 任意类型附件收发 | `media.mjs` |
| ✅ 视频消息 | 收发完整支持 | `media.mjs` |
| ✅ 流式回复 | message_state GENERATING → FINISH（打字机效果） | `messaging.mjs` |
| ✅ Typing 状态 | getConfig 缓存 + 周期续期 + 指数退避 | `typing.mjs` |
| ✅ Session 守护 | errcode=-14 自动暂停 1h，避免封禁 | `session-guard.mjs` |
| ✅ 错误恢复 | 连续失败退避、长轮询超时正常处理、游标防丢 | `poller.mjs` |
| ✅ 事件驱动 | `bot.on('message' \| 'image' \| 'voice' \| ...)` | `index.mjs` |
| ✅ context_token 管理 | 自动记录入站 token，出站自动回填 | `messaging.mjs` |

---

## 快速开始

### 环境要求
- Node.js **≥ 22**（使用内置 `fetch`、`crypto`、`AbortController`；与 `package.json` 的 `engines` 一致）
- 无需任何外部框架

### 安装

```bash
npm install
```

`npm install` 会装 1 个必需依赖（`dotenv`）+ 3 个可选依赖（缺失不影响核心功能）：

| 包 | 用途 | 缺失时行为 |
|---|---|---|
| `qrcode-terminal` | 终端渲染二维码（扫码登录） | 回退为打印二维码 URL，手动复制到浏览器扫码 |
| `silk-wasm` | SILK 语音解码为 WAV | 回退为保存原始 SILK 文件 |
| `@anthropic-ai/claude-agent-sdk` | 仅 Claude bridge demo 用 | demo 自动降级为回声模式 |

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

`npm run check` 的自检原理：对每个账号发起一次短超时（默认 3 s，可用 `WEIXIN_CHECK_TIMEOUT_MS` 调）的 `getUpdates` 长轮询，根据返回判定：

| 返回 | 判定 | 含义 |
|---|---|---|
| `ret=0`（含 `msgs`） | ✅ valid | token 有效，可能带回少量积压消息 |
| 客户端超时 | ✅ valid | token 有效，服务器 hold 到超时，无新消息 |
| `errcode=-14` | ⏰ expired | session 已过期，需重新 `--login` |
| 其他 `errcode` / HTTP 4xx | ❌ invalid | 鉴权/参数错误 |
| 网络异常 | 🌐 network_error | 连不通 iLink 服务器 |

#### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `WEIXIN_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `WEIXIN_CHECK_TIMEOUT_MS` | `3000` | token 自检长轮询超时（毫秒） |
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
- **群聊**：消息以 `/` 开头才触发（去掉前缀作为 prompt）

**配置**（环境变量，建议放 `.env`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_WORKSPACE` | 当前目录 | meta-agent 工作目录（**务必设为隔离目录**，agent 在此可读写文件/执行命令） |
| `META_AGENT_MODE` | `agentic` | `detect`/`agentic`/`auto`/`campaign`/`robotics`（⚠️ `auto` 是自主+沙箱，非自动检测） |
| `META_AGENT_MAX_TURNS` | `30` | 最大 agentic 轮数 |
| `META_AGENT_TIMEOUT_MS` | `300000` | 单任务超时 |
| `WEIXIN_TRIGGER_PREFIX` | `/` | 群聊触发前缀 |
| `WEIXIN_GROUP_TRIGGER` | `prefix` | 群聊策略：`off`/`prefix`/`all` |
| `WEIXIN_ALLOW_FROM` | (空) | 白名单 fromUserId，逗号分隔；留空=不限 |

> **安全**：meta-agent 在 workspace 内可读写文件、执行 shell。务必把 `META_AGENT_WORKSPACE` 指向专用隔离目录，并配置 `WEIXIN_ALLOW_FROM` 白名单，避免任意微信用户控制你的本地 agent。

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
// 本地文件（按扩展名自动路由 image/video/file）
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
| 框架依赖 | 无 | 绑定框架 SDK |
| 会话/路由/AI 编排 | 不含（由应用层决定） | 含（框架提供） |
| 协议覆盖 | 完整 | 完整 |
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

**必需依赖仅 `dotenv`**（用于 `.env` 加载）。所有可选依赖缺失时接入层核心功能不受影响。
