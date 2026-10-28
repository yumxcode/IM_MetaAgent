# IM MetaAgent

以 meta-agent 为执行底座的微信个人智能体。微信接入、聊天、工作执行、任务运维和人工回填有独立职责；委托与回复持久保存，机器人进程重启后继续核对执行回执。

## 四种会话模式

**进入和退出标记各自单独发送；模式内直接发送内容。** 未进入模式时只提醒先选择；退出时只接受当前模式对应的标记。切换前必须先退出当前模式。

| 模式 | 单独发送进入 | 模式内直接发送 | 单独发送退出 |
|---|---|---|---|
| 任务运维 | `/tasks` | 查看任务、继续上一个问题 | `tasks/` |
| 人工回填 | `/human` | help、H1 填写、字段值、提交 | `human/` |
| 普通聊天 | `/talk` | 聊天内容 | `talk/` |
| 工作执行 | `/auto` | 工作目标、后续补充要求 | `auto/` |

例如，下面每行是一条独立微信消息：

```text
/tasks
查看任务
展开第一个任务
tasks/
```

机器人进入时回复“已进入任务运维模式”，退出时回复“已退出任务运维模式”。`/tasks 查看任务 tasks/` 这种单条消息格式不再支持。引用消息里的标记不切换模式。

模式按机器人账号、用户、会话分别持久保存，重启后仍处于之前的模式。普通聊天有独立历史和受限工具；在聊天模式中发送 `--clear` 新建聊天上下文。聊天和运维在退出时关闭当前对话；再次进入创建全新的上下文。运维单次进入的上下文最长有效 24 小时。

工作模式保留各任务的独立上下文。进入 `/auto` 后会显示最近的任务，可直接发送 `A1`（或 `选择 A1`）选择任意属于当前会话的已有任务；选择动作本身不会执行工作。随后普通消息补充该任务，上一轮仍在执行时按顺序排队。发送 `列表` 查看全部微信任务；发送 `新建` 后描述目标，会创建另一任务。未选择任务时直接描述目标也会新建。显式 `--continue A1`、`--steer A1 补充要求` 仍可使用。退出只解除当前选择，不删除任务上下文；下次进入可重新选择。切换任务不会改变之前已经排队消息的归属。

退出模式不会取消已交办任务，也不会撤回已接收的消息。进入运维模式后发送 `im` 查看微信任务、`inspect A1` 查看详情、`cancel A1` 取消 IM 当前执行轮。runtime 后台作业和后续唤醒仍通过任务运维另行处理；执行轮返回不等于长期目标全部完成。

## 安装和运行

Node.js ≥ 20.18。IM 不安装或捆绑 runtime，需单独安装**包含 `@meta-agent/runtime/im` 契约 v1 的 runtime**。仅版本号达到 0.13.0、但未包含此接口的旧构建仍不能使用。先构建更新后的 runtime，再设置 `.env`：

```dotenv
META_AGENT_RUNTIME_DIR=/absolute/path/to/meta_agent_runtime
# 未单独指定 META_AGENT_BIN / META_AGENT_TASKS_BIN 时，使用上述目录的 dist/cli*.mjs。
WEIXIN_ALLOW_FROM=你的微信用户ID
META_AGENT_HUMAN_ENABLED=true
```

```bash
npm install
npm run agent:check
npm run agent:login
npm run agent
```

普通聊天/工作默认读取 runtime 的 config.json；运维默认读取 glm_config.json，可分别配置 `META_AGENT_TALK_PROFILE`、`META_AGENT_CONFIG_FILE`、`META_AGENT_TASKS_PROFILE`。各执行进程固定自身配置，调用任务运维不会修改聊天进程或后续工作的模型设置。完整配置见 [.env.example](.env.example)。

微信 iLink 当前以私聊为准，默认关闭群聊处理。所有消息先过访问控制：设置 `WEIXIN_ALLOW_FROM` 时只放行列出的用户；**未设置时只放行“主人”**——首位私聊者自动绑定为主人（升级时若只有一个历史私聊联系人则直接沿用），其他人的消息静默拒绝并发告警。`WEIXIN_ALLOW_FROM=*` 表示不限制（不建议）。登录、媒体、引用缓存和协议说明见 [接入层手册](README-standalone.md)。

## 个人助理能力

- **聊天可联网**：`/talk` 中可直接问需要最新信息的问题，助理用 runtime 的 `web_search` / `web_fetch` 查找并附来源（搜索服务需在 runtime 配置，如 Tavily 或 GLM）。聊天仍没有文件和命令工具。
- **提醒与定时**：在 `/talk` 中直接说“明天 8 点提醒我交周报”“工作日每天 9 点帮我搜一下行业新闻并总结”。提醒由机器人持久保存（`R1`、`R2`…），重启不丢；到点发送提醒（remind），或把指令当一轮聊天执行后发结果（talk）。机器人离线错过的一次性提醒会延迟补发，重复任务错过超过 1 小时的那次跳过。在 `/tasks` 中发送 `提醒` 查看、`cancel R1` 取消。时间按运行机器人的电脑本地时区。
- **交付文件回传**：Auto 任务用 `task_journal`（kind=artifact）登记的交付文件随结果发回微信；未登记时发送本轮新生成的文档/图片类文件（pdf、docx、xlsx、pptx、csv、图片、视频、zip 等）。只发送任务工作区内的文件，默认最多 5 个、单个 25MB，超出的列出路径。
- **待决策直接回复**：任务被 verify 判为“待决策”（runtime `needs-decision`，包括调度器唤醒后才出现的）时，机器人推送 `【待决策 A1】` 消息。在任何模式（人工回填除外）直接**引用这条消息回复**，或单独发送 `决定 A1 你的决定`，即作为 steer 交给原任务并继续执行。
- **掉线告警**：微信登录失效（errcode -14）、轮询连续失败超过 10 分钟、陌生人尝试使用、提醒 10 分钟内无法通过微信送达时，通过备用通道告警，恢复后再通知。通道复用 meta-agent 配置中的 `notify.channels`（飞书/Lark、Slack、webhook），或设置 `IM_ALERT_WEBHOOK_URL`；`IM_ALERT_DESKTOP=true` 增加 macOS 通知。`npm run agent -- --alert-test` 发送测试告警。

配置项见 [.env.example](.env.example)。

## 任务运维与项目

进入任务运维模式后，普通消息使用 runtime 任务快照和 ops 工具进行运维；运维历史按微信身份和本次进入分别隔离，退出重进不恢复上一段历史；单段最长有效 24 小时。查询、运行和纠偏沿用现有规则；runtime 的终止、删除等高危操作仍需终端确认。微信 A1 编号和 runtime 运维 T1 编号是不同视图。

项目操作统一放在 tasks 中：

下面每行是一条独立消息：

```text
/tasks
project list
project new 我的项目
project clone 我的代码 https://example.com/team/repo.git
project use 我的项目
project none
project archive 我的项目
tasks/
```

未选择项目时，每个新工作有独立 workspace；选定项目后，新任务共用该目录但按目录串行执行。每个工作仍有独立目标和 runtime 会话。项目名和路径会校验，克隆使用参数数组调用 Git；归档保留文件，有运行/排队工作时不允许归档。微信不再提供直接递归删除项目目录的入口。

旧 `/p`、`/goal`、`/sapiens`、`/clear` 入口不再支持；普通内容仅在已进入的模式中处理。旧项目、会话文件保留，不自动混入新聊天或新目标；旧 runtime 工作仍可通过 `/tasks` 查询和运维。新 IM 项目目录独立管理。

## 人工回填与附件

开启 `META_AGENT_HUMAN_ENABLED=true` 后，首次私聊自动绑定工单收件人。需要 agent 派人工工单的工作使用：

下面每行是一条独立消息（工单编号以实际通知为准）：

```text
/auto
--sapiens 完成设备检查，需要时给我派工单
auto/
/human
help
H1 接单
H1 填写
是
提交
human/
```

每个字段直接回复即可，文件字段可直接发送附件。`退出填写` 保留草稿；`human/` 退出交互模式，草稿仍保留；下次进入后发送 `help` 查看工单，再发送 `H1` 等编号选择上下文并恢复草稿。已结束工单可查看详情，不能继续填写。字段内容碰巧与命令相同，可用 `--value 字段内容`。

未进入模式时发送的附件会保存并提醒选择模式；10 分钟内进入相应模式后发内容，会绑定当前会话最近的附件。聊天只接受文本和图片，其他文件在工作模式中处理。工单仍检查文件来源、字段要求和权限，续跑需要 runtime 调度器，见 [人工工单说明](docs/human-tasks.md)。

## 持久化与恢复

新状态位于微信状态目录的 `personal-agent/`：

- `state.json`：持久收件箱、聊天/任务关联、项目索引、当前模式和工作上下文绑定、待发送回复、附件关联；原子替换并 fsync，同一目录仅允许一个接收实例。
- `executions/<id>/`：不可变请求、排他启动记录、心跳、会话编号、进度与结果；独立 supervisor 托管 runtime。
- `talk/`：聊天历史；`workspaces/`、`projects/`：工作目录；`attachments/`：入站文件副本。

入站消息落盘成功后才确认轮询游标；重复消息不会重复创建任务。达到执行上限时进入队列；运维使用独立控制额度。回复失败后保留并重试，重用稳定 client_id；同一会话后续来信刷新发送 token。

机器人进程重启不主动终止独立执行进程；重新连接时读取回执。执行进程已死且没有最终回执时标记 unknown，保留会话、不自动重复有副作用的工作。机器断电或服务管理器杀死整组进程后也按此方式处理；不能保证任意中断都可自动继续。

微信发送成功但本地回执落盘前崩溃仍有重复投递窗口，不承诺 exactly-once。结果发送受微信 token 有效性影响（会话 token 由你最近一条消息刷新；长时间不发消息后，提醒和结果可能要等你再发一条消息才能送达，提醒在此情况下会同时走告警通道）。当前 JSON 存储适合单机个人使用。

**数据保留**：每天自动清理 `IM_RETENTION_DAYS`（默认 30）天前已完成的收件、发件、执行记录及其执行目录、附件副本、交付文件快照，以及已关闭的聊天/运维上下文。运行中、排队、unknown、待发送的数据和工作任务记录本身不清理。`npm run agent -- --prune --dry-run` 预览。

**日志**：经 `deploy/start.sh` 启动时应用日志写入 `logs/im-metaagent.log`，按 10MB 轮转保留 5 份；相同的 warn/error 在 5 分钟窗口内只写一次并汇报重复次数。服务管理器的 `.out.log` / `.err.log` 只承接启动信息和崩溃堆栈，超过 20MB 时启动脚本保留末尾 1MB。

## 开发验证

```bash
npm run build
npm test
IM_TEST_RUNTIME_DIR=/absolute/path/to/built/runtime npm test
```

最后一条启用真实 runtime 的公开接口和人工工单集成测试，不连接真实微信、不调用付费模型。P0 设计与验收见 [说明](docs/p0-personal-agent.md)。部署和发布见 [INSTALL.md](INSTALL.md) 与 [deploy/README.md](deploy/README.md)。
