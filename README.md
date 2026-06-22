# IM MetaAgent

> 把本地 AI Agent（meta-agent / Claude Code）接入微信，在聊天框里远程驱动 agent 执行任务。

基于腾讯官方开放的 **iLink Bot API**（`ilinkai.weixin.qq.com`），零框架依赖的纯 ESM JavaScript 实现。

```
┌──────────┐   扫码登录    ┌─────────────────┐   spawn CLI    ┌──────────────┐
│  微信App  │ ───────────▶ │  本项目接入层    │ ────────────▶ │  meta-agent  │
│  私聊/群聊 │ ◀────────── │  (src/ + 桥接)   │ ◀──────────── │  / Claude    │
└──────────┘   消息回传    └─────────────────┘   JSONL 事件    └──────────────┘
```

## 它能做什么

- 🤖 **微信 ↔ Agent 桥接** — 私聊/群聊发消息，调用本地 meta-agent 执行，结果回到微信（支持多项目隔离 + 会话恢复）
- 💬 **完备消息能力** — 文本、图片（AES 加密 + CDN）、语音（SILK 解码 + 转文字）、文件、视频，全类型收发
- ✨ **流式回复** — 打字机效果（GENERATING → FINISH）+ 「正在输入」指示
- 🔐 **多账号 + 凭据持久化** — 重启免登，游标续接，session 过错自动退避防封
- 🧩 **两种 Agent 后端** — meta-agent CLI（项目级 workspace）或 Claude Code SDK（demo）

## 快速开始

### 环境要求
- Node.js **≥ 22**（用内置 `fetch` / `crypto` / `AbortController`）

### 安装

```bash
git clone https://github.com/yumxcode/IM_MetaAgent.git
cd IM_MetaAgent
npm install
```

`npm install` 只装 1 个必需依赖（`dotenv`），其余 `qrcode-terminal` / `silk-wasm` / `claude-agent-sdk` 为可选——缺失时自动降级，不影响核心功能。

### 三步跑通 meta-agent 桥接

```bash
# 1) 自检 meta-agent CLI 可用 + 打印配置
npm run agent:check

# 2) 微信扫码登录（首次；终端打印二维码）
npm run agent:login

# 3) 开始监听 —— 在微信发消息即可触发 agent
npm run agent
```

**触发规则**（默认，可配置）：
- 私聊：所有文本消息触发 agent
- 群聊：消息以 `/` 开头才触发

只想验证连通性、不接 AI？用回声监听：

```bash
npm run login     # 扫码登录
npm start         # 收到任何文本原样回复，验证收发链路
```

完整 CLI 命令（`check` / `accounts` / `logout` 等）见 [`README-standalone.md`](./README-standalone.md#快速开始)。

## 仓库结构

```
.
├── src/                        # 接入层核心（零框架依赖，可直接 import）
│   ├── index.mjs               # WeixinBot 主类 + 全部具名导出
│   ├── auth.mjs                # QR 登录 + 多账号 + 凭据持久化
│   ├── poller.mjs              # 长轮询主循环 + 错误恢复
│   ├── messaging.mjs           # 消息收发 + 入站解析 + contextToken
│   ├── media.mjs               # CDN 上传/下载 + AES 加解密 + SILK 解码
│   ├── session-guard.mjs       # Session 过错自动暂停防封
│   └── meta-agent-bridge.mjs   # meta-agent CLI 桥接（JSONL 事件解析）
├── weixin-meta-agent.mjs       # 微信 ↔ meta-agent 桥接（主入口）
├── wechat-claude-bridge.mjs    # 微信 ↔ Claude Code 桥接（demo）
├── weixin-login-check.mjs      # 登录 / 连通性验证 CLI
├── packages/                   # 腾讯官方插件代码（参考用，非本仓库维护重点）
├── protocol.md                 # 微信 ClawBot 功能使用条款
└── README-standalone.md        # 接入层完整 API 文档
```

## 两种 Agent 桥接

| 维度 | `weixin-meta-agent.mjs` | `wechat-claude-bridge.mjs` |
|---|---|---|
| 后端 | 本地 [meta-agent](https://github.com/yumxcode/meta_agent_runtime) CLI | Claude Code Agent SDK |
| 定位 | 主入口，项目级 workspace 隔离 + 会话恢复 | 接入示例 / demo |
| 多项目 | ✅ 每项目独立 workspace + session | ❌ 单会话 |
| 触发 | 私聊全响应 / 群聊前缀 `/` | 私聊全响应 |
| SDK 依赖 | 需全局安装 meta-agent CLI | `@anthropic-ai/claude-agent-sdk`（可选） |

主要配置（环境变量，建议放 `.env`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_WORKSPACE` | 当前目录 | agent 工作目录（**务必设为隔离目录**） |
| `META_AGENT_MODE` | `auto` | `detect`/`agentic`/`auto`/`campaign`/`robotics` |
| `WEIXIN_TRIGGER_PREFIX` | `/` | 群聊触发前缀 |
| `WEIXIN_GROUP_TRIGGER` | `prefix` | 群聊策略：`off`/`prefix`/`all` |
| `WEIXIN_ALLOW_FROM` | (空) | 白名单 fromUserId，逗号分隔 |

完整变量列表见 [`README-standalone.md`](./README-standalone.md#接入本地-agentmeta-agent-桥接)。

## ⚠️ 安全

meta-agent 在 workspace 内**可读写文件、执行 shell 命令**。通过微信触发时务必：

1. 把 `META_AGENT_WORKSPACE` 指向**专用隔离目录**，不要指向含敏感数据的目录
2. 配置 `WEIXIN_ALLOW_FROM` **白名单**，避免任意微信用户控制你的本地 agent
3. 群聊默认需 `/` 前缀触发，避免误触

## 作为库使用

接入层可独立 `import`，自建 Bot 逻辑：

```javascript
import { WeixinBot } from "./src/index.mjs";

const bot = new WeixinBot();
await bot.login();                          // 扫码登录（首次）

bot.on("message", async (msg) => {
  await bot.reply(msg, `你说的是：${msg.text}`);
});

await bot.start();                          // 阻塞，开始长轮询
```

按消息类型分别处理、发送媒体、流式回复、多账号等完整示例见 [`README-standalone.md`](./README-standalone.md#作为库使用)。

## 合规说明

本接入层调用腾讯官方开放的 iLink Bot API，受《微信 ClawBot 功能使用条款》约束（全文见 [`protocol.md`](./protocol.md)）。关键点：

- 腾讯仅提供消息通道，**不存储内容、不提供 AI 服务**
- 腾讯可随时限速、拦截、终止服务，不应将核心业务完全依赖此 API
- 禁止用于违法违规、绕过微信技术保护措施等行为

## License

仅供学习研究使用。使用本接入层与微信交互的行为，需遵守《腾讯微信软件许可及服务协议》《微信个人账号使用规范》及上述 ClawBot 条款。
