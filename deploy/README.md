# 进程守护部署

让 IM MetaAgent 在崩溃后自动重启、开机后自动拉起。

## 方案选择

| 方案 | 平台 | 特点 |
|---|---|---|
| **launchd**（推荐 macOS） | macOS 原生 | 零依赖、登录自启、崩溃重启 |
| **systemd**（推荐 Ubuntu/Linux 服务器） | Linux 原生 | 零依赖、开机自启、崩溃重启、24/7 在线 |
| **pm2**（跨平台备选） | macOS / Linux | Node 生态熟悉、内存监控、集群 |

---

## 方案一：launchd（macOS）

### 一键安装

```bash
bash deploy/install.sh
```

install.sh 会自动：
1. 检查 node（通过 nvm login shell 解析，**不写死版本路径**）
2. 检查 meta-agent CLI
3. 渲染 plist（把 `__PROJECT_DIR__` 替换为绝对路径）
4. 加载到 `~/Library/LaunchAgents/`
5. 启动并打印状态

### 前置条件

```bash
# 1. 已安装 Node.js >= 22（通过 nvm）
nvm install 22 && nvm alias default 22

# 2. 已安装 meta-agent CLI
npm install -g @meta-agent/runtime

# 3. 已扫码登录微信账号（至少一次）
npm run agent:login
```

### 守护行为

| 事件 | 行为 |
|---|---|
| 用户登录 macOS | ✅ 自动启动（`RunAtLoad`）|
| 进程崩溃（OOM / 信号 / 异常退出）| ✅ 15 秒后自动重启（`KeepAlive.Crashed`）|
| 进程正常退出（exit 0）| ❌ 不重启（`SuccessfulExit: false`）|
| 连续崩溃 | launchd 自动熔断，停止重启 |

### 常用命令

```bash
# 查看状态
launchctl list | grep com.yumx.im-metaagent

# 停止（必须用 unload，不要用 kill —— 否则被判定崩溃而重启）
launchctl unload ~/Library/LaunchAgents/com.yumx.im-metaagent.plist

# 启动
launchctl load ~/Library/LaunchAgents/com.yumx.im-metaagent.plist

# 重启
launchctl unload ~/Library/LaunchAgents/com.yumx.im-metaagent.plist && \
launchctl load ~/Library/LaunchAgents/com.yumx.im-metaagent.plist

# 查看日志
tail -f logs/im-metaagent.out.log
tail -f logs/im-metaagent.err.log

# 卸载（停止 + 删除 plist，不删代码和日志）
bash deploy/uninstall.sh
```

> ⚠️ **不要用 `kill` 停止服务**——会被 launchd 判定为崩溃而自动重启。停机请用 `launchctl unload`。

### nvm 路径问题

launchd 启动的进程**不会加载 shell profile**，因此不会自动 source nvm。
`deploy/start.sh` 通过内部 `bash -lc`（login shell）动态解析 node，
**切换 Node 版本后无需改任何配置**。

---

## 方案二：systemd（Ubuntu / Linux 服务器）

适用于 VPS / 云服务器 / 任何 systemd Linux。**服务器 24/7 在线，Mac 可随意休眠。**

### 一键安装

```bash
bash deploy/install-linux.sh
```

install-linux.sh 会自动：
1. 检查 node（通过 nvm 解析，不写死版本路径）
2. 检查 meta-agent CLI
3. 渲染 service 文件（替换路径占位符 + 当前用户名）
4. 安装到 `/etc/systemd/system/`（需要 sudo）
5. 启用开机自启 + 启动 + 打印状态

### 前置条件

```bash
# 1. 安装 nvm + Node.js >= 22
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm alias default 22

# 2. 安装 meta-agent CLI
npm install -g @meta-agent/runtime

# 3. 配置 meta-agent API key（meta-agent 读自己的配置，与本项目无关）
#    按 meta-agent 文档配置 ~/.meta-agent/config.json

# 4. 扫码登录微信账号（服务器终端会打印 ASCII 二维码或二维码 URL）
npm run agent:login
```

### 守护行为

| 事件 | 行为 |
|---|---|
| 服务器开机 | ✅ 自动启动（`WantedBy=multi-user.target`）|
| 进程崩溃（OOM / 信号 / 异常退出）| ✅ 15 秒后自动重启（`Restart=on-failure`）|
| 进程正常退出（exit 0）| ❌ 不重启 |
| 5 分钟内崩溃 >10 次 | ⛔ 自动熔断，停止重启（`StartLimitBurst`）|

### 常用命令

```bash
# 查看状态（含最近 10 行日志）
sudo systemctl status im-metaagent

# 停止 / 启动 / 重启
sudo systemctl stop im-metaagent
sudo systemctl start im-metaagent
sudo systemctl restart im-metaagent

# 实时日志（systemd journalctl）
sudo journalctl -u im-metaagent -f

# 文件日志（与 macOS 方案一致）
tail -f logs/im-metaagent.out.log
tail -f logs/im-metaagent.err.log

# 卸载（停止 + 禁用 + 删 service，保留代码和日志）
bash deploy/uninstall-linux.sh
```

### 服务器扫码登录（无图形界面）

服务器通常没有图形界面，扫码登录有两种方式：

```bash
# 方式 1：终端 ASCII 二维码（已安装 qrcode-terminal 时自动渲染）
npm run agent:login

# 方式 2：打印二维码 URL，复制到浏览器打开扫码
#         （未安装 qrcode-terminal 时自动回退为此方式）
WEIXIN_LOG_LEVEL=debug npm run agent:login
```

扫码成功后凭据持久化到 `~/.weixin-bot/`，之后 systemd 服务会自动加载，**无需再次扫码**。

---

## 方案三：pm2（跨平台）

### 安装与启动

```bash
npm install -g pm2
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save                    # 保存进程列表
pm2 startup                 # 生成开机自启（按提示执行返回的命令）
```

### 常用命令

```bash
pm2 status                    # 状态
pm2 logs im-metaagent         # 实时日志
pm2 restart im-metaagent      # 重启
pm2 delete im-metaagent       # 停止并移除
```

---

## 日志

两种方案都把日志写到项目内 `logs/` 目录：

| 文件 | 内容 |
|---|---|
| `logs/im-metaagent.out.log` | stdout（结构化 JSON 日志 + 回复确认）|
| `logs/im-metaagent.err.log` | stderr（错误、session 过期告警、meta-agent stderr）|

日志会持续增长，建议定期清理或用 logrotate / newsyslog 轮转。
