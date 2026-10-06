# 微信 iLink Bot 协议与本项目接入

本项目通过腾讯 iLink Bot API 与微信私聊连接，默认 API 地址为 `https://ilinkai.weixin.qq.com`，默认媒体 CDN 为 `https://novac2c.cdn.weixin.qq.com/c2c`。

核对日期：**2026-10-06**。协议行为对照腾讯官方发布的 `@tencent-weixin/openclaw-weixin` **2.4.9**；参考安装器 `@tencent-weixin/openclaw-weixin-cli` 为 **2.1.4**。**2.4.9 是插件版本号，不是独立的服务端协议版本。** 官方客户端代码与类型能说明请求构造和客户端兼容行为，不能替代完整的服务端契约。

官方来源：[协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)、[变更日志](https://github.com/Tencent/openclaw-weixin/blob/main/CHANGELOG.zh_CN.md)、[插件包](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)、[安装器包](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli)。本仓库 `packages/` 保存这两个经过核对的 npm 发布包及原有 LICENSE，独立接入层实际运行的是 `src/*.mjs`。

## 当前接入范围

腾讯官方插件当前声明支持微信**私聊**。协议类型保留 `group_id` 等字段，本项目保留旧群聊路由逻辑用于兼容，但不据此承诺服务端已开放群聊接入。

本项目在私聊中支持文本、图片、语音、文件及视频。语音接收优先使用服务端转文字，下载后可用可选的 `silk-wasm` 解码；语音发送要求 SILK V3 编码，普通 MP3/WAV 以文件附件发送。流式消息、Typing 指示、运行通知和工具进度的显示效果由微信客户端与服务端决定。

微信聊天中的 `/tasks` 属于本地应用功能，访问本机的 meta-agent runtime，不是腾讯新增的 task API。命令详见 [README](./README.md#在微信查看和管理-glm-任务)。

## 请求信息与鉴权

鉴权 Bot POST 请求使用 JSON，携带以下头部：

| Header | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `AuthorizationType` | `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>` |
| `X-WECHAT-UIN` | 随机 uint32 的十进制字符串再 base64 编码 |
| `iLink-App-Id` | `bot` |
| `iLink-App-ClientVersion` | 插件版本编码为 `0x00MMNNPP` 后的十进制值，2.4.9 对应 `132105` |
| `SKRouteTag` | 可选路由标签 |

由 `fetch` 计算 `Content-Length`，避免 Node 24/undici 对手动头部的兼容问题。鉴权 Bot API 的 JSON 带公共信息：

```json
{
  "base_info": {
    "channel_version": "2.4.9",
    "bot_agent": "IMMetaAgent/1.0.0"
  }
}
```

`bot_agent` 是可清洗的客户端观测标识，不参与鉴权或路由。本项目可通过 `WEIXIN_BOT_AGENT` 设置。二维码状态 GET 使用应用头部，不带 Bot Bearer token、`AuthorizationType` 或 `X-WECHAT-UIN`；获取二维码的 POST 不注入 `base_info` 或 Bearer token。

## 扫码登录

| 操作 | 方法和路径 |
|---|---|
| 获取二维码 | `POST /ilink/bot/get_bot_qrcode`，JSON 包含 `bot_type` |
| 查询二维码状态 | `GET /ilink/bot/get_qrcode_status?qrcode=<值>` |
| 带数字配对码继续查询 | 上述 GET 增加 `verify_code=<值>` |

登录从固定 API 地址开始，确认后保存 `bot_token`、`ilink_bot_id`、`ilink_user_id` 与 `baseurl`，后续 API 使用账号的 `baseurl`。状态处理包括：

| 状态 | 本项目行为 |
|---|---|
| `wait` / `scaned` | 继续轮询 |
| `confirmed` | 保存并使用确认后的凭据 |
| `expired` | 有限次数刷新二维码 |
| `need_verifycode` | 交互终端提示输入手机显示的数字配对码；非交互模式返回可继续登录的结果 |
| `verify_code_blocked` | 停止当前验证码重试，有限次数刷新二维码，持续失败时明确提示重新登录 |
| `scaned_but_redirect` | 验证返回地址后切换轮询地址 |
| `binded_redirect` | 返回已连接状态并保留现有凭据；没有可用凭据时明确提示 |

库调用可用 `startLogin` / `waitForLogin` 两阶段接口；数字配对码通过 `onVerifyCode` 或 `verifyCode` 传入。取消信号与登录总时限贯穿请求和等待过程。

## Bot API

| 操作 | POST 路径 | 用途 |
|---|---|---|
| `getUpdates` | `/ilink/bot/getupdates` | 长轮询获取消息，回传 `get_updates_buf` |
| `sendMessage` | `/ilink/bot/sendmessage` | 发送文本、媒体或工具进度 |
| `getUploadUrl` | `/ilink/bot/getuploadurl` | 获取媒体上传地址/参数 |
| `getConfig` | `/ilink/bot/getconfig` | 获取 Typing ticket |
| `sendTyping` | `/ilink/bot/sendtyping` | 设置/取消输入状态 |
| `notifyStart` | `/ilink/bot/msg/notifystart` | 通知后端客户端启动 |
| `notifyStop` | `/ilink/bot/msg/notifystop` | 通知后端客户端停止 |

本项目同时检查 HTTP 状态与 `ret` / `errcode` 的非零错误。`-14` 表示 token 失效，触发账号暂停轮询。长轮询超时属于正常等待；外部取消用于退出监听。启动/停止通知失败不阻断运行。错误正文、凭据、密钥和签名参数经过脱敏，不把原始响应内容当作用户操作指令。

发送回复时回传入站消息的 `context_token`。回复上下文缓存按账号与用户隔离使用，避免把一个账号的回复上下文用于另一账号。媒体说明文字与媒体本体按独立消息发送，每条有独立 `client_id`。

## 媒体传输

上传流程：检查文件大小 → 计算明文 MD5 → 生成随机 AES-128 key → `getUploadUrl` → POST AES-128-ECB/PKCS7 密文 → 校验 CDN 响应头 `x-encrypted-param`。

`getUploadUrl` 的 `media_type` 为 `1` 图片、`2` 视频、`3` 文件、`4` 语音；请求带 `rawsize`、`rawfilemd5`、`filesize`、`aeskey`（hex）和 `no_need_thumb`。

- 返回非空 `upload_full_url` 时直接 POST 该完整地址，不追加查询参数；缺省时用 `upload_param` 构造旧 CDN 上传 URL。
- 入站 `CDNMedia.full_url` 优先作为下载地址；缺省时使用 `encrypt_query_param` 构造旧下载 URL。
- `CDNMedia.aes_key` 兼容 base64(原始 16 字节) 与 base64(32 ASCII hex 字符)。出站按官方发送代码使用 base64(hex 字符串)。
- 本项目只接受 HTTP/HTTPS 媒体地址，逐块读取并执行大小限制，超时覆盖整个响应正文。明文最大 100 MiB；密文允许 PKCS7 填充空间，但解密后仍核对明文限额。
- CDN 上传 4xx 立即停止；服务器错误或网络错误有限重试。超时和用户取消停止当前请求。仅使用实际响应头的下载参数，不把上传参数误用为下载参数。
- 本地媒体读取前先检查文件 stat；远程下载失败不留部分临时文件；入站附件名剥离路径，安全写入目标目录。

## 消息类型、引用与工具进度

`message_type`：`1` 用户、`2` Bot。`message_state`：`0` 新消息、`1` 生成中、`2` 完成。

| `item_list[].type` | 内容 |
|---|---|
| `1` | 文本 |
| `2` | 图片 |
| `3` | 语音 |
| `4` | 文件 |
| `5` | 视频 |
| `11` | `TOOL_CALL_START` |
| `12` | `TOOL_CALL_RESULT` |

消息 ID 与引用 `svr_id` 是线上 uint64，本项目无损保留为字符串，避免先转换成 JavaScript Number 后丢失精度。新版微信只发送引用消息 ID 时，从按账号、发送者和会话隔离的近期缓存还原可用文本和附件；未命中时明确保留缺少引用原文的状态。缓存不能凭空读取本机没有接收过的微信历史消息。

工具开始/结束事件通过工具进度 item 发送，发送失败不影响本地 Agent 执行和最终回复。Typing 与生成中状态并不代替持久化任务检查点；微信 `/tasks progress` 展示的是本地 runtime 已保存的实际数据。

## 安装与更新参考包

独立桥接使用根目录 `npm install`、`npm test` 和 `npm run build`。`packages/` 不加入根 npm workspaces，避免参考插件的 OpenClaw peer 依赖影响独立服务安装；其中的官方包保留原始发布内容及许可证。

已有账号凭据、游标、任务配置沿用原路径。切换代码后须重启实际监听进程；只替换参考插件目录不会更新运行中的 `src/`。自检通过说明本地配置及网络访问正常，消息收发、数字配对码与媒体显示仍需在当前微信账号上实际验证。

使用条款原有存档见 [protocol.md](./protocol.md)。这里描述的是客户端接入行为，不对微信服务能力、可用性或法律许可作额外承诺。
