# 微信 iLink Bot 接入层

一个**零框架依赖**的微信个人号 Bot 接入层，基于腾讯官方开放的 **iLink Bot API**（`ilinkai.weixin.qq.com`）。

- **`src/`（本文件所述）**：独立的纯 ESM JavaScript 接入层，可直接 `import` 使用。
- **`weixin-meta-agent.mjs`**：微信 ↔ meta-agent 桥接，在微信上远程调用本地 meta-agent 执行任务。
- **微信任务管理**：先单独发送 `/tasks` 进入模式，再直接发送自然语言 通过 `tasks --agentic` 运维对话查询和管理本机任务。
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

当前个人智能体使用四种会话模式：单独发送 `/tasks`、`/human`、`/talk` 或 `/auto` 进入，直接发送内容，单独发送对应的 `tasks/`、`human/`、`talk/` 或 `auto/` 退出。未进入模式的内容仅收到提醒，不能使用其他模式的退出标记。详见 [README](README.md) 与 [P0 说明](docs/p0-personal-agent.md)。

`src/` 的微信收发库 API 保持独立。自建业务可继续订阅 `message`；需要可靠收件时传入 `inboundHandler`，该回调必须在消息持久化后返回，失败会阻止轮询游标前移。不要在回调里等待长任务完成。`sendText` 可传固定 `clientId` 关联投递重试。

`runMetaAgent` 支持显式 `intent: new | continue | steer | new_goal`；非 new 必须传 resumeSessionId，新任务不能传旧会话。支持 AbortSignal、JSONL 尾行和有界输出；临时网络/模型错误不会清空个人智能体的会话关联。

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
