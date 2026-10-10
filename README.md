# IM MetaAgent

> 把本地 AI Agent（meta-agent / Claude Code）接入微信，在聊天框里远程驱动 agent 执行任务。

基于腾讯官方开放的 **iLink Bot API**（`ilinkai.weixin.qq.com`），零框架依赖的纯 ESM JavaScript 实现。独立接入层已同步官方插件 **2.4.9** 的协议变化；参考安装器版本为 **2.1.4**（核对日期：2026-10-06）。版本号来自插件包，不是独立的服务端 API 版本。

官方插件声明支持微信**私聊**。`group_id` 和原有群聊路由配置用于兼容已有消息结构，不代表当前腾讯服务提供群聊接入。

```
┌──────────┐   扫码登录    ┌─────────────────┐   spawn CLI    ┌──────────────┐
│  微信App  │ ───────────▶ │  本项目接入层    │ ────────────▶ │  meta-agent  │
│  微信私聊  │ ◀────────── │  (src/ + 桥接)   │ ◀──────────── │  / Claude    │
└──────────┘   消息回传    └─────────────────┘   JSONL 事件    └──────────────┘
```

## 本次协议同步

- 扫码登录改用 POST 获取二维码，支持数字配对码、重定向、二维码过期和已绑定状态。
- 请求带 `iLink-App-Id`、编码后的 `iLink-App-ClientVersion` 和 `base_info.bot_agent`；取消手动 `Content-Length`，兼容 Node 24。
- 媒体优先使用服务端 `upload_full_url` / `full_url`，保留旧加密参数；支持两种 AES key 编码，限制媒体大小并覆盖正文下载超时。
- 引用消息 ID 无损处理，并按账号和会话还原近期已缓存的引用内容。
- 启动/停止通知和工具执行进度接入独立桥接，原有 GLM 任务查询及管理命令保持可用。

技术说明见 [iLink 协议说明](./weixin-bot-api.md)。对照来源：[官方变更日志](https://github.com/Tencent/openclaw-weixin/blob/main/CHANGELOG.zh_CN.md)、[官方协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)。

## 它能做什么

- 🤖 **微信 ↔ Agent 桥接** — 私聊发消息，调用本地 meta-agent 执行，结果回到微信（支持多项目隔离 + 会话恢复）
- 📋 **微信任务管理** — 查看 `meta-agent-glm tasks` 的运行项目、最近进展、日志和报告，在聊天中调度、追加指令或终止任务
- 💬 **消息能力** — 文本、图片、语音、文件和视频；语音接收可使用服务端转文字和可选 SILK 解码，语音发送要求 SILK V3 编码
- ✨ **流式回复** — 打字机效果（GENERATING → FINISH）+ 「正在输入」指示
- 🔐 **多账号 + 凭据持久化** — 重启免登，游标续接，token 失效后自动暂停轮询
- 🧩 **两种 Agent 后端** — meta-agent CLI（项目级 workspace）或 Claude Code SDK（demo）

## 快速开始

### 环境要求
- Node.js **≥ 20.18**（用内置 `fetch` / `crypto` / `AbortController`）

Node 20 可运行微信收发、媒体、任务查询和管理；历史引用缓存依赖内置 SQLite，仅在 Node ≥ 22.13 时启用，Node 20 自动关闭该可选缓存。

### 安装

```bash
git clone https://github.com/yumxcode/IM_MetaAgent.git
cd IM_MetaAgent
npm install
```

`npm install` 安装必需依赖 `dotenv`，并尝试安装 `qrcode-terminal`、`silk-wasm`和 `@anthropic-ai/claude-agent-sdk` 等可选依赖。`packages/` 是官方发布包的参考副本，不加入 npm workspaces，安装独立桥接不会拉入 OpenClaw。运行 `npm test` 验证独立接入层；`npm run build` 对 ESM 入口和模块做语法检查，无需编译。

发布包安装、保留配置更新与回滚见 [`INSTALL.md`](./INSTALL.md)。发布包不安装 meta-agent runtime；后端使用服务器已有的独立安装。

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
- 私聊可使用 `/tasks`、`/p`、`/goal` 等命令；其他文本交给 Agent
- 原有群聊配置仅作为兼容策略保留，当前官方接入以私聊为准

只想验证连通性、不接 AI？用回声监听：

```bash
npm run login     # 扫码登录
npm start         # 收到任何文本原样回复，验证收发链路
```

完整 CLI 命令（`check` / `accounts` / `logout` 等）见 [`README-standalone.md`](./README-standalone.md#快速开始)。

## 在微信查看和管理 GLM 任务（tasks --agentic）

启动桥接后，在微信发送 `/tasks <自然语言>`。它桥接 meta-agent runtime 的 `tasks --agentic` 运维控制台：由运维模型先读取任务快照再回答或操作，支持多轮追问，无需记忆固定命令语法。

任务运维需要 meta-agent runtime **≥ 0.11.3**。运行 `npm run agent:tasks-check`（等价于 `node weixin-meta-agent.mjs --tasks-check`）可只读检查后端与任务列表，无需连接微信、不调用模型。

```text
/tasks                          查看当前任务概览
/tasks 运行中的任务有哪些         自然语言查询
/tasks 看下第 1 个任务的详情和最近日志
/tasks 让它立即跑一轮             请求执行一次已到期的唤醒
/tasks 给它追加指令：先跑测试再提交   给任务写入纠偏指令
/tasks 上次运行的结果怎么样了       结合快照与活动日志回答
```

能力与边界：

- 每轮回答前自动注入最新任务快照（含 T1/T2… 短别名，可直接说"让 T3 跑一轮"），运行/纠偏（`ops.task.run` / `ops.task.steer`）直接执行；查询不会启动无关任务。
- **终止、删除、取消、Studio 生命周期**等高危操作不在微信侧授权——回复会指引到终端 `meta-agent-glm tasks --agentic` 确认执行（可用 `META_AGENT_TASKS_ALLOW_STUDIO_CONTROL=true` 放开 Studio 控制）。
- 私聊也支持“查看任务”“任务列表”“运行中的项目”“运行中的任务”“最近进展 [任务]”“查看进展 <任务>”这些完整短语直达运维对话。全部指令受 `WEIXIN_ALLOW_FROM` 白名单约束，Agent 忙碌时仍可使用。

**运维会话存储时间**：运维对话保存在 `TasksAgenticSessionStore` 中，**固定 24 小时有效期**（runtime 硬编码，不可延长）。过期后历史自动清空并新建会话，微信会在首次回复中提示“已续接/已新建/已过期重建”及到期时间；写操作的回执（receipts）持久保留，不受轮转影响。微信侧会话与终端控制台相互隔离（默认根目录 `~/.meta-agent/task-ops/weixin`），互不抢占。

任务后端配置（均可省略，建议放 `.env`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_TASKS_BIN` | `meta-agent-glm` | 任务后端命令或可执行文件路径 |
| `META_AGENT_TASKS_PROFILE` | `~/.meta-agent/glm_config.json` | 运维会话的模型配置（也决定会话 scope） |
| `META_AGENT_TASKS_WORKSPACES` | 全部 | 逗号分隔的绝对路径，限定控制台可见工作区 |
| `META_AGENT_TASKS_MAX_TURNS` | `30` | 单轮运维对话的最大模型轮数 |
| `META_AGENT_TASKS_MAX_BUDGET_USD` | `10` | 运维会话累计费用上限（24 小时内） |
| `META_AGENT_TASKS_TURN_TIMEOUT_MS` | `300000` | 单条微信消息的超时，超时中断并保存进度；`0` 不限 |
| `META_AGENT_TASKS_MAX_RUNNING` | `3` | 托管执行器并发上限（1–64） |
| `META_AGENT_TASKS_OPS_ROOT` | `~/.meta-agent/task-ops/weixin` | 运维会话存储根目录 |
| `META_AGENT_TASKS_ALLOW_STUDIO_CONTROL` | `false` | 是否允许微信侧执行 Studio 生命周期操作 |
| `META_AGENT_TASKS_RUNTIME_DIR` | 自动发现 | 已安装的 meta-agent runtime 根目录 |

这是 `tasks --agentic` 的聊天入口：与终端控制台共用 TaskControlService / ops 工具 / 托管执行器（显式准入，不会自动跑到期任务）；模型配置沿用 `glm_config.json`，不会向工作进程转发控制器密钥。

## 仓库结构

```
.
├── src/                        # 接入层核心（零框架依赖，可直接 import）
│   ├── index.mjs               # WeixinBot 主类 + 全部具名导出
│   ├── auth.mjs                # QR 登录 + 多账号 + 凭据持久化
│   ├── poller.mjs              # 长轮询主循环 + 错误恢复
│   ├── messaging.mjs           # 消息收发 + 入站解析 + contextToken
│   ├── media.mjs               # CDN 上传/下载 + AES 加解密 + SILK 解码
│   ├── session-guard.mjs       # Token 失效后暂停轮询
│   └── meta-agent-bridge.mjs   # meta-agent CLI 桥接（JSONL 事件解析）
├── weixin-meta-agent.mjs       # 微信 ↔ meta-agent 桥接（主入口）
├── wechat-claude-bridge.mjs    # 微信 ↔ Claude Code 桥接（demo）
├── weixin-login-check.mjs      # 登录 / 连通性验证 CLI
├── packages/                   # 官方发布包参考副本（插件 2.4.9 / CLI 2.1.4）
├── protocol.md                 # 微信 ClawBot 功能使用条款
└── README-standalone.md        # 接入层完整 API 文档
```

## 两种 Agent 桥接

| 维度 | `weixin-meta-agent.mjs` | `wechat-claude-bridge.mjs` |
|---|---|---|
| 后端 | 本地 [meta-agent](https://github.com/yumxcode/meta_agent_runtime) CLI | Claude Code Agent SDK |
| 定位 | 主入口，项目级 workspace 隔离 + 会话恢复 | 接入示例 / demo |
| 多项目 | ✅ 每项目独立 workspace + session | ❌ 单会话 |
| 触发 | 私聊全响应，支持 `/tasks` 等命令 | 私聊全响应 |
| SDK 依赖 | 需全局安装 meta-agent CLI | `@anthropic-ai/claude-agent-sdk`（可选） |

主要配置（环境变量，建议放 `.env`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `META_AGENT_MODE` | `simple_auto` | 普通对话模式；`/goal <目标>` 使用完整 `auto` 模式 |
| `WEIXIN_TRIGGER_PREFIX` | `/` | 群聊触发前缀 |
| `WEIXIN_GROUP_TRIGGER` | `prefix` | 群聊策略：`off`/`prefix`/`all` |
| `WEIXIN_ALLOW_FROM` | (空) | 白名单 fromUserId，逗号分隔 |

完整变量列表见 [`README-standalone.md`](./README-standalone.md#接入本地-agentmeta-agent-桥接)。

## ⚠️ 安全

meta-agent 在 workspace 内**可读写文件、执行 shell 命令**。通过微信触发时务必：

1. 使用 `/p` 管理项目，确认项目 workspace 中允许 Agent 读写和执行命令
2. 配置 `WEIXIN_ALLOW_FROM` **白名单**，避免任意微信用户控制你的本地 agent
3. 登录凭据和媒体会写入本机状态目录，请限制目录访问权限

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
