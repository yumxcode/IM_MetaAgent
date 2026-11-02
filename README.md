# IM MetaAgent

以 meta-agent 为执行底座的微信个人智能体。微信接入、聊天、工作执行、任务运维和人工回填有独立职责；委托与回复持久保存，机器人进程重启后继续核对执行回执。

## 直接发消息（1.5）

**不再需要进入或退出模式。** 所有消息都交给一个常驻的助理（meta-agent `simple_auto`）：

- **聊天、搜索、写东西、处理发来的文件、设提醒**：助理直接做完，结果和文件发回微信。
- **大任务**（写代码、改项目、整理一批文件、完整的调研报告）：助理先和你确认工作文件夹——按你的描述在允许的文件夹里查找、浏览、查看项目，必要时提议新建——然后发出确认消息：

```text
【P1·确认】准备启动工作任务
目标：修复登录失败的问题
目录：~/code/IM_MetaAgent（git main，3 个未提交改动）
其他候选：2. ~/code/wechat-demo
回复“确认”开始，回复编号改选目录，“取消”放弃；要改目录或目标直接说。
```

回复“确认”（或“2”“取消”）由机器人直接处理，**助理不能替你确认**。确认后在该文件夹启动 auto 工作任务（独立进程，长时间运行），进度、结果、待决策会主动通知。之后直接跟助理说“A1 进展如何”“给 A1 补充……”“取消 A1”即可。

助理能访问的文件夹由 `IM_WORKSPACE_ROOTS` 限定（如 `~/code,~/work`）；未设置时，工作任务只使用机器人管理的独立目录。

**主动消息带标记**：`【A1·结果】`、`【A1·状态】`、`【待决策 A1】`、`【R2·提醒】`、`【R3·定时】`、`【P1·确认】`。引用这些消息回复时，会带着对应任务/提醒的上下文交给助理（引用【待决策】直接交给任务）；没引用也没关系，两次对话之间发出的通知会在下一轮附给助理，可以直接说“刚才那个提醒推迟一小时”。

快捷命令（可选，单条消息）：

| 命令 | 作用 |
|---|---|
| `/auto 目标` | 明确作为工作任务交办（助理先确认文件夹）；`/auto --continue A1`、`/auto --steer A1 内容`、`/auto --sapiens 目标` 直接执行 |
| `/tasks` | 查看工作任务；`/tasks inspect A1`、`/tasks cancel A1`、`/tasks resend A1`、`/tasks 提醒`、`/tasks cancel R1`、`/tasks project …`；其他内容交给后台任务运维 |
| `/pending`、`/respond H1 填写` | 查看待处理、回填人工工单 |
| `/new` | 新建聊天上下文（工作任务不受影响） |
| `/notify …` | 通知设置 |

旧的 `/talk`、`/auto`、`talk/`、`auto/` 等单独的模式标记只会收到提示，不再切换任何东西。

## 安装和运行

Node.js ≥ 20.18。IM 不安装或捆绑 runtime，需单独安装**包含 `@meta-agent/runtime/im` 契约 v1 的 runtime**；常驻助理需要 runtime ≥ 0.14（提供 `meta-agent serve`），更早的版本自动退回单次运行。先构建更新后的 runtime，再设置 `.env`：

```dotenv
META_AGENT_RUNTIME_DIR=/absolute/path/to/meta_agent_runtime
# 选择 CLI：meta-agent（默认，config.json）或 meta-agent-glm（glm_config.json）；所有用途统一使用
META_AGENT_CLI=meta-agent
WEIXIN_ALLOW_FROM=你的微信用户ID
META_AGENT_HUMAN_ENABLED=true
# 助理可以浏览、可以在里面开展工作任务的文件夹
IM_WORKSPACE_ROOTS=~/code
```

```bash
npm install
npm run agent:check   # 会显示是否支持常驻助理
npm run agent:login
npm run agent
```

auto 工作任务、聊天助理、tasks 运维和人工工单统一使用同一个 CLI 和同一份模型配置，由 `META_AGENT_CLI` 选择：`meta-agent`（默认，读取 `~/.meta-agent/config.json`）或 `meta-agent-glm`（读取 `glm_config.json`）；`META_AGENT_CONFIG_FILE` 可显式覆盖配置文件。IM 总是把解析出的配置以 `META_AGENT_CONFIG_FILE` 显式传给子进程，`npm run agent:check` 的 `runtimeCli` 显示实际使用的 CLI、可执行文件和配置。1.5.2 及以前的分用途变量（`META_AGENT_TASKS_BIN`、`META_AGENT_HUMAN_BIN`、`META_AGENT_TALK_PROFILE`、`META_AGENT_TASKS_PROFILE`）已停用并被忽略，启动日志会提示。完整配置见 [.env.example](.env.example)。

微信 iLink 当前以私聊为准，默认关闭群聊处理。所有消息先过访问控制：设置 `WEIXIN_ALLOW_FROM` 时只放行列出的用户；**未设置时只放行“主人”**——首位私聊者自动绑定为主人（升级时若只有一个历史私聊联系人则直接沿用），其他人的消息静默拒绝并发告警。`WEIXIN_ALLOW_FROM=*` 表示不限制（不建议）。登录、媒体、引用缓存和协议说明见 [接入层手册](README-standalone.md)。

## 个人助理能力

- **常驻助理（需 meta-agent ≥ 0.14）**：IM 启动一个 `meta-agent serve --mode simple_auto` 进程并监管它（定时 ping，卡住或退出就重启，10 分钟内异常退出超过 5 次则停用）。每条消息作为一轮发给它，会话、配置和 MCP 连接常驻内存，不再每条消息冷启动。聊天有自己的工作区（工作区监狱）和会话，历史保留、每条消息都是当前请求；`/new` 新建上下文。助理通过 IM 提供的工具浏览文件夹（只读、限于白名单）、提议任务、查询/补充/取消任务、设提醒、打开工单；这些工具由 IM 执行并校验。处理中显示“正在输入”，超过 20 秒再发“正在处理”（`IM_SLOW_NOTICE_MS`）。日志记录每轮的排队、首个事件和总耗时。runtime 不支持 `serve` 时自动退回单次运行（每条消息一次 CLI，`.im/remind.mjs` 提交提醒，没有文件夹工具）；`IM_TALK_SERVE=false` 强制单次运行。
- **聊天与工作分开排队**：聊天不占 `META_AGENT_MAX_CONCURRENT` 的工作额度，长时间的 auto 任务不会挡住聊天回复。
- **助理的 skill 与 MCP（需 meta-agent ≥ 0.13.3）**：simple_auto 只读自己的 `~/.meta-agent/mcp.simple_auto.json` 和 `~/.meta-agent/skills/simple_auto/`，与工作任务（auto）等其他 runtime 模式互不可见。运行 `npm run agent:setup-simple-auto`（可先加 `-- --dry-run` 预览）会：把 `mcp.json` 里已有的服务复制过去（没有 `autoAllow` 的设为 `"readOnly"`）、补上 GLM 搜索 `web-search-prime` 和 `12306-mcp`、复制全局 skills、安装 IM 自带的 Word/Excel/PPT/PDF 办公 skill（基于 python-docx、openpyxl、python-pptx、pypdf、pdfplumber、reportlab 和 LibreOffice），并检查依赖。`mcp.json` 与全局 skills 不会被修改。
- **轮数与预算**：工作任务与聊天默认使用 meta-agent 自身的上限（每次运行 1000 轮、会话累计 $300）。需要限制时设置 `META_AGENT_AUTO_MAX_TURNS` / `META_AGENT_AUTO_MAX_BUDGET_USD` / `META_AGENT_TALK_MAX_TURNS` / `META_AGENT_TALK_MAX_BUDGET_USD`；旧的 `META_AGENT_MAX_TURNS` / `META_AGENT_MAX_BUDGET_USD` 已停用。聊天单条消息默认 15 分钟超时（`META_AGENT_TALK_TIMEOUT_MS`）。
- **提醒与定时**：直接说“明天 8 点提醒我交周报”“工作日每天 9 点帮我搜一下行业新闻并总结”。提醒由机器人持久保存（`R1`、`R2`…），重启不丢；到点发送提醒（remind），或把指令交给 runtime 定时执行后发结果（talk）。机器人离线错过的一次性提醒会延迟补发，重复任务错过超过 1 小时的那次跳过。`/tasks 提醒` 查看、`/tasks cancel R1` 取消，也可以直接跟助理说。时间按 `/notify timezone` 设置的时区（未设置时按运行机器人的电脑时区）。
- **交付文件回传**：工作任务用 `task_journal`（kind=artifact）登记的交付文件随结果发回微信；未登记时发送本轮新生成的文档/图片类文件（pdf、docx、xlsx、pptx、csv、图片、视频、zip 等）。只发送任务工作区内的文件，默认最多 5 个、单个 25MB，超出的列出路径。聊天中保存到工作区 `outbox/` 的文件同样发回。
- **待决策直接回复**：任务被 verify 判为“待决策”（runtime `needs-decision`，包括调度器唤醒后才出现的）时，机器人推送 `【待决策 A1】` 消息。直接**引用这条消息回复**、发送 `决定 A1 你的决定`，或直接告诉助理（助理用 `task_decide` 交给任务），即作为 steer 交给原任务并继续执行。
- **掉线告警**：微信登录失效（errcode -14）、轮询连续失败超过 10 分钟、陌生人尝试使用、提醒 10 分钟内无法通过微信送达时，通过备用通道告警，恢复后再通知。通道复用 meta-agent 配置中的 `notify.channels`（飞书/Lark、Slack、webhook），或设置 `IM_ALERT_WEBHOOK_URL`；`IM_ALERT_DESKTOP=true` 增加 macOS 通知。`npm run agent -- --alert-test` 发送测试告警。

配置项见 [.env.example](.env.example)。

## 工作文件夹、任务运维与项目

**允许助理访问的文件夹**：`.env` 中设置 `IM_WORKSPACE_ROOTS=~/code,~/work`（逗号分隔，绝对路径或 `~/` 开头；不能是根目录或整个家目录）。助理只能读这些根目录下文件夹的元数据：名称、README/package/pyproject 摘要、git 分支/远程（去掉凭据）/未提交改动数/最近提交、两层目录结构；不读其他文件内容。所有路径先解析真实路径，必须落在某个根目录内（不能是根目录本身），符号链接不能跳出。新建文件夹只在你确认后进行。工作任务在确认的文件夹里运行，同一文件夹的任务串行；你的文件夹里附件放在隐藏的 `.im-inputs/`。auto 带 `--yes` 运行、会直接修改文件，请只把愿意交给它改的目录放进白名单。macOS 用 launchd 运行时，`~/Documents`、`~/Desktop`、`~/Downloads` 受系统隐私保护，除非给 node 完全磁盘访问权限，否则会读不到；建议用 `~/code` 这类目录。

**任务运维**：`/tasks 内容` 交给 runtime 任务运维控制台（查看后台任务、运行与纠偏），历史按微信身份保存，单段最长 24 小时；助理也可以用 `ops_query` 代你查询。runtime 的终止、删除等高危操作仍需终端确认。微信 A1 编号和 runtime 运维 T1 编号是不同视图。

**机器人管理的项目**（可选，供 `/auto 目标` 直接交办时使用）：

```text
/tasks project list
/tasks project new 我的项目
/tasks project clone 我的代码 https://example.com/team/repo.git
/tasks project use 我的项目
/tasks project none
/tasks project archive 我的项目
```

项目名和路径会校验，克隆使用参数数组调用 Git；归档保留文件，有运行/排队工作时不允许归档。微信不提供递归删除项目目录的入口。

## 人工回填与附件

开启 `META_AGENT_HUMAN_ENABLED=true` 后，首次私聊自动绑定工单收件人。需要人工配合的工作，告诉助理（它会在提议里标明“含人工协作”），或发送 `/auto --sapiens 完成设备检查，需要时给我派工单`。处理工单：

```text
/pending
/respond H1 接单
/respond H1 填写
是
提交
```

进入填写后，你的消息逐项作为字段值（文件字段直接发附件），直到“提交”或“退出填写”（草稿保留）；也可以直接让助理“打开 H1 填写”。已结束工单可查看详情，不能继续填写。字段内容碰巧与命令相同，可用 `--value 字段内容`。

聊天可以直接处理文件和图片；语音消息按转写文字处理。工单仍检查文件来源、字段要求和权限，续跑需要 runtime 调度器，见 [人工工单说明](docs/human-tasks.md)。

## 持久化与恢复

新状态位于微信状态目录的 `personal-agent/`：

- `state.json` + `state.journal`：持久收件箱、聊天/任务关联、任务提议、通知记录、项目索引、待发送回复（含来源标记）、附件关联。每次更新只把改动的记录追加到 `state.journal`（fsync），日志超过 2MB 或快照一半大小时、每日清理后和退出时合并成新的 `state.json`（原子替换）；启动时回放日志，末行写了一半会忽略，中间损坏则拒绝启动。同一目录仅允许一个接收实例。收件记录不保存原始报文；已完成的执行记录不保存 runtime 配置和提醒列表副本，提示词和回复截短（完整回复已发到微信）。
- `executions/<id>/`：不可变请求、排他启动记录、心跳、会话编号、进度与结果；独立 supervisor 托管 runtime。
- `talk/`：聊天工作区；`runtime-sessions/`：聊天与任务的 runtime 会话；`serve/`：常驻助理的工具声明；`workspaces/`、`projects/`：机器人管理的工作目录；`attachments/`：入站文件副本。

入站消息落盘成功后才确认轮询游标；重复消息不会重复创建任务。达到执行上限时进入队列；运维使用独立控制额度。回复失败后保留并重试，重用稳定 client_id；同一会话后续来信刷新发送 token。

机器人进程重启不主动终止独立执行进程（工作任务）；重新连接时读取回执。常驻助理随机器人启停；重启时正在处理的那条聊天不会重放（它可能已经调用过工具），会提示你重发。执行进程已死且没有最终回执时标记 unknown，保留会话、不自动重复有副作用的工作。机器断电或服务管理器杀死整组进程后也按此方式处理；不能保证任意中断都可自动继续。

微信发送成功但本地回执落盘前崩溃仍有重复投递窗口，不承诺 exactly-once。结果发送受微信 token 有效性影响（会话 token 由你最近一条消息刷新；长时间不发消息后，提醒和结果可能要等你再发一条消息才能送达，提醒在此情况下会同时走告警通道）。当前 JSON 存储适合单机个人使用。

**数据保留**：每天自动清理 `IM_RETENTION_DAYS`（默认 7）天前已完成的收件、发件、执行记录及其执行目录、附件副本、交付文件快照，已关闭的聊天/运维上下文、已结束的任务提议和通知记录，以及聊天工作区中过期的 `im-inputs/` 附件副本、`outbox/` 文件和定时执行的每次运行目录。运行中、排队、unknown、待发送的数据和工作任务记录本身不清理。独立目录任务的工作区默认不删（里面有交付文件），`IM_PRUNE_TASK_WORKSPACES=true` 时在任务结束并超过保留期后删除，之后该任务不能继续。`npm run agent -- --prune --dry-run` 预览。

**后台核对**：任务状态和待决策在机器人进程内一次批量查询（不再每个任务启动一个 meta-agent 进程），只查还可能变化的任务（运行中、排队、暂停、待决策，或最近 3 天结束的）；有进行中的任务时每 2 分钟一次，否则每 10 分钟，没有这类任务时不查询。定时执行只同步生效中的定时，runtime 状态变化时才读回执；状态没变不写盘；调度进程已在运行时不再重复拉起。

**日志**：经 `deploy/start.sh` 启动时应用日志写入 `logs/im-metaagent.log`，按 10MB 轮转保留 5 份；相同的 warn/error 在 5 分钟窗口内只写一次并汇报重复次数。服务管理器的 `.out.log` / `.err.log` 只承接启动信息和崩溃堆栈，超过 20MB 时启动脚本保留末尾 1MB。

## 开发验证

```bash
npm run build
npm test
IM_TEST_RUNTIME_DIR=/absolute/path/to/built/runtime npm test
```

最后一条启用真实 runtime 的公开接口和人工工单集成测试，不连接真实微信、不调用付费模型。常驻助理设计见 [docs/assistant.md](docs/assistant.md)，P0 设计与验收见 [说明](docs/p0-personal-agent.md)。部署和发布见 [INSTALL.md](INSTALL.md) 与 [deploy/README.md](deploy/README.md)。
