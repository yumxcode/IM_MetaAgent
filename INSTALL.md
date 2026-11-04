> 1.5.5 升级说明（决定与补充交给 runtime；一问一答）：对 runtime 正在管理的任务（运行中、挂起等待唤醒、待决策），微信里的决定和补充不再由 IM 另起一个 `meta-agent --resume --steer` 进程去跑，而是通过 runtime 的 `task.steer` 排队、`task.run` 让该 wake 立即执行。效果：回复决定后 `meta-agent tasks --manage` 立刻显示为运行，日志里能看到“指示 › 恢复时收到…”；不会再出现看板一直显示 decide、随后变成 park、日志里找不到决定的情况，也不会和定时唤醒同时跑同一个会话。已结束的任务（finished/failed/orphaned）仍由 IM 自己恢复。助理调用补充/决定/取消时不再单独发【A·补充】【A·决定】回显，改为附在助理这条回复末尾；交给 runtime 的那一轮不再另发【A·结果】，后续结局照常由【A·状态】/【待决策】报告。直接发“决定 A1 …”或引用【待决策】回复时，只回一条【A1·决定】说明是否已恢复执行。IM 自己执行的一轮挂起时，【A·结果】写成“本次执行已挂起，约 50 分钟后由 runtime 自动继续”，不再显示原始的 `Auto session parked for …ms`。助理在你只是询问进度时不再擅自给任务补充指令。**需要 meta-agent runtime ≥ 0.14.6**（待决策 wake 回复后立即可被 `tasks --manage` 接管、恢复时把排队的决定作为首条指令并写入日志）；旧 runtime 下决定仍能送达，但要等独立的 auto-scheduler 接手。无配置变化。
>
> 1.5.4 升级说明（通知整理）：任务完成时不再重复通知——聊天发起的执行已发过 `【A·结果】` 的，runtime 状态变为 finished/failed 时不再另发 `【A·状态】`；只有 runtime 在后台自行结束的任务才发 `【A·状态】`，且只带任务第一行标题、runtime 说明和 `/tasks inspect` 指引，不再附上完整任务说明。超过单条上限的长消息改为在空行、换行或句末处分段，并在每段末尾标注（1/2）这样的序号。无配置变化，直接替换升级即可。
>
> 1.5.3 升级说明（统一 CLI）：auto 工作任务、聊天助理、tasks 运维和人工工单改为统一使用同一个 CLI 和同一份模型配置，由新选项 `META_AGENT_CLI` 选择：`meta-agent`（默认，读取 `~/.meta-agent/config.json`）或 `meta-agent-glm`（读取 `glm_config.json`）。**以前 tasks 运维和人工工单默认走 `meta-agent-glm`，升级后默认改为 `meta-agent`**；想全部使用 glm 配置，在 `shared/.env` 中加 `META_AGENT_CLI=meta-agent-glm`。`META_AGENT_TASKS_BIN`、`META_AGENT_HUMAN_BIN`、`META_AGENT_TALK_PROFILE`、`META_AGENT_TASKS_PROFILE` 已停用并被忽略；`META_AGENT_TASKS_RUNTIME_DIR` 仍可用，建议改名为 `META_AGENT_RUNTIME_DIR`。升级后运行 `npm run agent:check`，`runtimeCli` 一节显示实际使用的 CLI、可执行文件和配置文件，以及需要清理的旧变量。
>
> 1.5.2 升级说明（长任务被误杀修复）：去掉了 auto 任务输出流 4MB 的累计上限。以前长时间运行的 auto 任务会因此被 IM 中途终止，结果显示为 `output_limit`，这与模型输出长度无关。现在只跳过单条超过 8MB 的事件行，不再终止任务。配合 meta-agent ≥ 0.14.2 时，IM 会通过环境变量 `META_AGENT_JSON_EVENTS=lean` 请求精简事件流（省略 thinking 增量和工具入参/结果正文，管道流量约为原来的 1/500）；旧版 runtime 会忽略这个变量，照常工作。如需完整事件流，在 `shared/.env` 中设置 `META_AGENT_JSON_EVENTS=full`。之前因 `output_limit` 中断的任务，改动都还在工作区，升级后直接续跑即可。
>
> 1.5.1 升级说明（存储与清理）：状态改为快照 `state.json` + 追加日志 `state.journal`，首次启动时自动把旧记录瘦身一次；任务状态改为进程内批量核对，定时同步只在状态变化时写盘；回滚到旧版本前先正常停止机器人（退出时会把日志合并进 `state.json`，旧版本只读 `state.json`）。默认保留期改为 7 天（`IM_RETENTION_DAYS`），需要更久请在 `shared/.env` 中设置。

> 1.5.0 升级说明：不再有模式，所有消息交给常驻助理；大任务由助理确认工作文件夹、你回复“确认”后启动。常驻助理需要 meta-agent ≥ 0.14（`meta-agent serve`）——先升级并构建 runtime（`npm run build`），`npm run agent:check` 的 `residentAssistant` 显示“支持”即可；旧 runtime 自动退回单次运行，功能可用但没有文件夹工具和任务确认。在 `shared/.env` 中加入 `IM_WORKSPACE_ROOTS=~/code`（助理可访问、可在其中开展工作任务的文件夹，按需填写），其余新配置见 `.env.example` 的“1.5 常驻助理”一节。旧聊天历史保留，升级后继续在同一会话；1.4 留在某个模式里的状态自动清除。macOS launchd 下不要把 `~/Documents`、`~/Desktop`、`~/Downloads` 放进白名单（受系统隐私保护）。

> 1.4.1 升级说明：需要 meta-agent ≥ 0.13.3（simple_auto 使用独立的 `~/.meta-agent/mcp.simple_auto.json` 与 `~/.meta-agent/skills/simple_auto/`）。升级 meta-agent 后在 IM 目录运行一次 `npm run agent:setup-simple-auto`，再重启服务。

> 1.4.0 升级说明：`/talk` 改为通过 meta-agent CLI 的 `simple_auto` 模式运行（IM 不再在进程内创建 runtime），自动获得 runtime 的工具、搜索服务和 `~/.meta-agent/mcp.json` 中的 MCP 服务；每段聊天有独立工作区和会话，旧版聊天历史不迁移。`/auto`、`/talk` 默认使用 meta-agent 自身的轮数/预算，旧的 `META_AGENT_MAX_TURNS` / `META_AGENT_MAX_BUDGET_USD` 被忽略，需要限制时改用 `META_AGENT_AUTO_*` / `META_AGENT_TALK_*`（见 `.env.example`）。`/tasks` 运维控制台仍使用 runtime 的公开 `@meta-agent/runtime/im` 接口。

> 1.3.0 升级说明：未设置 `WEIXIN_ALLOW_FROM` 时改为**仅主人可用**（首位私聊者绑定；已有唯一私聊联系人直接沿用；有多个历史联系人时拒绝所有消息，需设置白名单或 `npm run agent -- --bind-owner <ID>`）。新增掉线告警、日志轮转、聊天联网与提醒、交付文件回传、待决策回复和 30 天数据清理，配置见 `.env.example`；`deploy/start.sh` 有改动，更新后重启服务即可，无需重装。

> 1.2.0 升级要求：先构建含 `@meta-agent/runtime/im` 契约 v1 的 runtime。设置 `META_AGENT_RUNTIME_DIR=/absolute/path/to/meta_agent_runtime`，或升级独立安装并确保 CLI 与公开接口来自同一构建。微信先单独发送 `/tasks`、`/human`、`/talk` 或 `/auto` 进入模式，随后直接发内容，单独发送对应 `xxx/` 退出。旧入口不再触发，旧资料保留。详见 [P0 说明](docs/p0-personal-agent.md)。

# IM_MetaAgent 1.5.5 远端安装与更新

本发布包只包含 IM_MetaAgent：独立微信接入层、桥接入口、测试、部署脚本及腾讯官方参考代码（插件 2.4.9 / 安装器 2.1.4）。不包含 meta-agent runtime、依赖目录、本机配置、微信凭据、任务数据或日志；安装脚本不会安装或更新 runtime。

## 前提

- Linux 服务器使用 Node.js **≥ 20.18**、npm、tar；托管服务要求 systemd，安装服务时需要 sudo。
- 服务器已单独安装并配置 meta-agent。聊天任务运维对话（tasks --agentic）要求 **runtime ≥ 0.11.3**；`.env` 的 `META_AGENT_CLI` 选择所有用途统一使用的 `meta-agent` 或 `meta-agent-glm`，PATH 找不到时设置 `META_AGENT_RUNTIME_DIR`。
- 人工工单微信通知需要支持 `human_task.*` 的 runtime（建议 ≥ 0.12.1）。在 `.env` 设置 `META_AGENT_HUMAN_ENABLED=true`，重启后私聊机器人一条消息即可自动绑定为唯一收件人，无需填写 `userId`。配置和回填方式见 [人工工单接入说明](docs/human-tasks.md)。
- 使用与服务器任务调度器相同的系统用户、`META_AGENT_HOME` 和 GLM 配置。微信读取服务器上的任务文件；不会自动读取另一台 Mac 的 tmux 任务。
- 同一个微信 Bot 账号保留一个消息接收实例。迁移同一账号时，在服务器启动前停止旧机器的 IM 接收服务。

## Node 20 兼容范围

Node.js 20.18 及以上可安装并运行独立 IM 接入层。微信收发、媒体、任务状态/日志、任务控制和调度继续可用。Node 20 自动关闭依赖内置 SQLite 的历史引用缓存，不会根据历史消息 ID 还原本地缓存的文本或媒体；消息自身包含的引用文本仍可使用。升级至 Node 22.13 及以上后，引用缓存可自动启用。切换至 Node 20 不会删除已保存的引用数据库。

`packages/` 中腾讯官方参考插件仍保留它自身的 Node ≥ 22.13 要求；该插件不参与 IM 安装。

## 首次安装

将 `im-metaagent-1.5.5.tar.gz` 和 `im-metaagent-1.5.5.sha256` 上传到服务器同一目录，以运行任务的普通用户执行：

```bash
sha256sum -c im-metaagent-1.5.5.sha256
tar -xzf im-metaagent-1.5.5.tar.gz
cd im-metaagent-1.5.5
node scripts/install-release.mjs "$HOME/apps/IM_MetaAgent" --no-service
```

安装过程校验发布清单，安装 IM 的 npm 依赖并检查语法。第一次会生成 `~/apps/IM_MetaAgent/shared/.env`，使用编辑器修改此文件。路径要使用服务器路径，不能沿用 Mac 上的 `/Users/...`。

```dotenv
# 所有用途统一使用的 CLI：meta-agent（config.json）或 meta-agent-glm（glm_config.json）
META_AGENT_CLI=meta-agent-glm
# runtime 根目录可由 CLI 自动发现，必要时手动指定：
# META_AGENT_RUNTIME_DIR=/absolute/path/to/installed/runtime
# 如果任务调度器设置了 META_AGENT_HOME，此处必须一致：
# META_AGENT_HOME=/home/your-user/.meta-agent
# 模型配置默认随 META_AGENT_CLI（${META_AGENT_HOME}/config.json 或 glm_config.json），必要时显式指定：
# META_AGENT_CONFIG_FILE=/absolute/path/to/glm_config.json
WEIXIN_ALLOW_FROM=your-weixin-user-id
WEIXIN_REPLY_PROGRESS_MESSAGES=true
# 开启人工工单通知；首次私聊自动绑定收件人。
META_AGENT_HUMAN_ENABLED=true
```

同一用户已有登录和项目状态时会继续使用原状态目录。新服务器没有这些数据，需要扫码登录并配置 runtime 的模型凭据。扫码后可通过账号信息/收到消息的发送者 ID 填写白名单。

```bash
cd "$HOME/apps/IM_MetaAgent/current"
npm run agent:check
npm run agent:tasks-check
npm run agent:login
bash deploy/install-linux.sh
sudo systemctl status im-metaagent
```

`agent:tasks-check` 只读，不会启动任务、不调用模型。先确认能读取与 tmux 中相同的任务，再从微信先发送 `/tasks`，再发送“查看任务”验证运维对话，最后发送 `tasks/` 退出。Linux 安装脚本启用开机自启、崩溃重启，并在系统已有 logrotate 时为 systemd 的 stdout/stderr 文件安装轮转规则；应用日志 `im-metaagent.log` 由程序自身轮转。

## npm 全局安装和启动

本地发布包也可以全局安装；使用包内入口文件启动：

```bash
npm install -g ./im-metaagent-1.5.5.tar.gz
IM_APP="$(npm root -g)/im-metaagent"
mkdir -p "$HOME/im-metaagent"
cd "$HOME/im-metaagent"
[ -f .env ] || cp "$IM_APP/.env.example" .env
# 编辑此目录 .env，配置服务器的 task 路径和微信白名单
node "$IM_APP/weixin-meta-agent.mjs" --check
node "$IM_APP/weixin-meta-agent.mjs" --tasks-check
node "$IM_APP/weixin-meta-agent.mjs" --login
node "$IM_APP/weixin-meta-agent.mjs"
```

配置放在用户目录，升级全局包后继续从该目录运行。后台守护和保留配置回滚建议使用前述版本化安装。

## 更新已有安装

上传新发布包及校验文件，校验、解压后从新解压目录运行同一个安装器，目标目录始终保持一致：

```bash
# 以 1.5.5 为例；后续替换成新版本的文件名和目录名
sha256sum -c im-metaagent-1.5.5.sha256
tar -xzf im-metaagent-1.5.5.tar.gz
cd im-metaagent-1.5.5
node scripts/install-release.mjs "$HOME/apps/IM_MetaAgent" --service
```

每次更新创建独立版本目录，先安装依赖、校验文件和检查语法，再原子切换 `current`、记录 `previous` 并重启 systemd 服务。代码或依赖检查失败时，当前版本不切换；服务安装/启动失败时会恢复上一版并尝试重启旧服务。服务的短暂存活检查不代表微信登录或远端接口健康，更新后仍需发消息验证。

`shared/.env` 不会被覆盖，`shared/logs/` 不会删除。微信凭据、引用缓存、项目和会话继续留在该系统用户原有的状态目录，安装器不会读写这些数据。默认不自动清理历史版本，可在确认运行正常后自行清理不用的版本。

升级后如需开启人工工单通知，在现有 `shared/.env` 添加 `META_AGENT_HUMAN_ENABLED=true` 并重启服务，再私聊机器人一条消息完成自动绑定。已有唯一私聊记录时会直接沿用；无需设置默认用户 ID。

如果服务器原来是直接运行旧 Git 目录，可以将该目录作为安装目标：安装器会导入其 `.env`，保留旧文件，在目标下增加 `releases/`、`shared/`、`current`。旧日志留在原目录。首次迁移后自动回滚仅覆盖后续版本化更新；迁移前的旧代码仍保留，必要时手动切回原服务配置。使用不同目标目录时，请自行把旧 `.env` 复制到新 `shared/.env` 并修改路径。

如果用 PM2、tmux 或其他托管方式，请使用 `--no-service`，然后用自己的托管工具重新启动 `current/deploy/start.sh`。`--service` 专用于 systemd；不要同时启用 PM2 和 systemd 接收同一个账号。

## 回滚

```bash
cd "$HOME/apps/IM_MetaAgent/current"
node scripts/install-release.mjs "$HOME/apps/IM_MetaAgent" --rollback --service
```

回滚检查上一版的发布清单和语法，切换代码并重启服务，不改共享配置。非 systemd 安装使用 `--rollback --no-service`，之后自行重启托管工具。

## 长期运行与查看任务

- 服务器持续在线时，IM 可由 systemd 长期运行；系统重启会恢复服务，异常退出会重启。网络错误会退避重试；微信 token 真正失效时仍需要重新扫码。
- 多个 shell 的 `tasks --agentic` 和微信可以读取同一份任务状态。任务认领采用跨进程锁及租约，避免同时启动同一个有效轮次。
- 微信 `/tasks` 桥接 runtime 的运维控制台（显式准入执行器，只响应"让它跑一轮"这类请求，不自动执行到期任务）；到期任务建议由 tmux 或独立服务调度。
- 微信侧运维会话固定 24 小时有效，过期自动重建（回复中会提示）；与终端控制台会话相互隔离。
- 终止、删除、取消等高危操作请在终端 `meta-agent tasks --agentic`（或 `meta-agent-glm`，与 `META_AGENT_CLI` 一致）中确认执行，微信侧默认不授权。
- 进展与活动日志按请求读取快照和已有 worker 日志，不自动持续推送每一步进展。
- 更新或重启 IM 会中断由该服务启动的 Agent/托管工作进程。独立 tmux manager 不属于 IM 服务；它的状态仍可继续读取。

```bash
# 接收服务状态
sudo systemctl status im-metaagent
# 消息/错误日志（journalctl 主要显示服务启停信息）
tail -f "$HOME/apps/IM_MetaAgent/shared/logs/im-metaagent.log"      # 应用日志（自身按 10MB 轮转）
tail -f "$HOME/apps/IM_MetaAgent/shared/logs/im-metaagent.err.log"  # 启动信息与崩溃堆栈
# 停止接收服务
sudo systemctl stop im-metaagent
```

## 本地生成后续发布包

更新根目录 `package.json` 的版本，并同步锁文件后执行：

```bash
npm run build
npm test
npm run release
```

输出位于 `release/`：版本化 tar.gz、SHA-256 文件及文件清单。远端依赖按锁文件安装，不包含平台相关的本地 `node_modules`。没有完整 npm 缓存时安装需要联网；`--offline` 仅用于依赖已缓存的环境。
