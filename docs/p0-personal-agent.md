# P0：四类入口与可靠执行

交互为持久会话模式：单独发送 `/tasks`、`/human`、`/talk`、`/auto` 进入，模式内直接发内容，单独发送对应 `tasks/`、`human/`、`talk/`、`auto/` 退出。未进入、退出不匹配或未退出就切换时仅提醒；引用文字不能切换模式。

## 边界

- message-trigger：语法与白名单。
- personal-agent：身份、Conversation/PersonalTask 映射、收件箱、工作队列、发件箱、项目元数据。
- runtime-adapter：唯一 runtime 适配入口；Auto 使用公开 CLI JSONL，聊天和运维使用公开 `@meta-agent/runtime/im`，人工工单使用 capability CLI。
- execution-worker：独立传输 supervisor，排他认领一次请求；执行内核、工具权限、Auto 后续调度仍由 runtime 负责。
- durable-store：单写者，原子写入和文件/目录 fsync，读取损坏文件失败退出，避免静默清空。

每次进入 Auto 后的首个目标不带 resume；同模式后续普通消息按顺序 steer 当前任务，等待上一轮结束。Auto 退出重进时可按任务编号选择原任务上下文，也可新建；显式 continue/steer 绑定原任务、模式和配置，恢复前查询 runtime 状态，拒绝同时启动正在运行或执行权待核验的任务。聊天使用无工作工具的 AgenticSession，历史不与 Auto 共用。

## 崩溃窗口

| 窗口 | 行为 |
|---|---|
| 收件落盘前 | 不确认轮询游标，等待重投 |
| 收件落盘后、路由前 | 启动后处理 queued |
| 路由后、执行进程启动前 | 用同一 requestId 和执行目录重试交接 |
| 重复 supervisor 启动 | started.json 排他创建；最多一个执行模型/工具 |
| 结果落盘后、机器人读取前 | 重启后读取结果并生成确定性发件项 |
| supervisor 异常退出且无结果 | unknown，保留 session，阻止自动重跑及同 workspace 后续工作 |
| 回复请求失败 | 持久退避，最新 token，固定 client_id |
| 发送成功但落盘前崩溃 | 可能重复投递；稳定 client_id 是尽力去重，不能推断服务端 exactly-once |

人工工单原有服务继续保存草稿、投递记录和提交结果核验；普通回复接入统一 outbox，通知本身沿用原有持久投递流程。

## 部署

Runtime 需构建公开 `/im` 子路径。`META_AGENT_RUNTIME_DIR` 指定根目录并作为默认 CLI 来源；显式 BIN 配置优先。`META_AGENT_TASKS_RUNTIME_DIR` 兼容保留。每个 detached worker 导入 runtime 前固定自己的 profile，主机器人进程不修改全局模型配置。

默认 work 并发 2，运维对话独立允许 1 个；runtime 的运维执行器仍保留自身 max-running。二者不是跨所有 runtime 调度器的全局预算或全局并发锁。

systemd 模板只终止消息主进程；launchd 模板允许独立执行进程存活。停止机器人不等于取消任务。更新部署模板后需要重新安装服务才能生效。PM2 或外部编排器若强制杀进程树，将走 unknown 核验路径；独立的 runtime 调度器需要按原部署方式保持运行。

不读取或重写 runtime 的私有 checkpoint。旧 IM 项目和会话文件保留，新入口不会自动恢复旧 Auto 目标。旧任务可通过 runtime 运维查询。历史清理、持续个人记忆、跨进程总预算和通用网页审批属于后续阶段。

## 验收覆盖

独立进入/退出、错误退出、禁止直接切换、模式重启恢复、重复进入退出投递、账号/用户/群隔离、引用伪装、白名单、模式内直接人工答复、附件、同一工作上下文续接与排队；新目标隔离、聊天上下文串行、模式保持；重复消息、排队、收件重启、启动交接中断、双 worker 抢占、回执恢复、未知状态；发送失败与 token 刷新；项目越界和运行中归档；超时强制终止、取消、JSONL 尾行；真实 runtime 人工回执与附件入库。

未发送真实微信消息或调用付费模型；上线后仍应以自己的微信账号完成一次真实交互验收。

## 会话模式状态

`state.modes` 保存每个身份的当前 kind/sessionId；`state.modeSessions` 保留已接收消息所属的工作上下文和 taskId。进入/退出、收件和确认回复在同一次状态事务落盘；去重在模式更新前执行。每条内容在接收时固定路由，随后退出或切换不会误投到另一模式。退出不取消运行中或已排队的工作。原有版本 1 状态会补齐这两个字段，已有历史和执行回执保留。


聊天历史以 modeSessionId 为键，运维 opsRoot 也包含 modeSessionId，因此 talk/tasks 退出重进不会复用旧上下文。Auto 的 A1 等任务持久保存，每次进入可选任务，选择/列表/新建是本地控制操作，不调用模型；已排队普通消息固定 autoTaskId，切换选择不改变其归属。Human 按 modeSessionId 清除当前工单选择但保留 drafts；按 H1 或完整工单编号选择后恢复原草稿，已结束工单只读。
