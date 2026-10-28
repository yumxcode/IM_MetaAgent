# IM_MetaAgent 服务部署

完整的远端安装、更新和回滚步骤见 [INSTALL.md](../INSTALL.md)。发布包只安装 IM，meta-agent runtime 使用已有独立安装；任务运维对话（tasks --agentic）要求 runtime ≥ 0.11.3、Node.js ≥ 20.18。

## Linux / systemd

配置 `.env`，确认 `npm run agent:tasks-check` 可读取服务器任务，并完成 `npm run agent:login` 后，在项目目录执行：

```bash
bash deploy/install-linux.sh
sudo systemctl status im-metaagent
sudo systemctl restart im-metaagent
sudo systemctl stop im-metaagent
```

服务以安装时的系统用户运行。启用开机自启，异常退出后 15 秒重启；5 分钟内启动次数超过 10 次时停止重试。正常退出不会重启；处理故障后可重新运行安装脚本。Node 和外部 CLI 通过安装时 PATH 及显式 nvm 加载发现。

stdout/stderr 写入项目 `logs/`（版本化安装时链接到 `shared/logs/`），`journalctl` 主要显示服务管理信息。已有 logrotate 时自动安装每日轮转、保留 7 份及压缩规则；未安装时需自行安装 logrotate 后重跑安装脚本。

```bash
tail -f logs/im-metaagent.err.log
sudo journalctl -u im-metaagent -n 30 --no-pager
bash deploy/uninstall-linux.sh
```

卸载会移除 systemd 服务及本项目的 logrotate 配置，保留代码、配置和日志。

## macOS / launchd

现有部署入口保持可用：

```bash
bash deploy/install.sh
bash deploy/uninstall.sh
```

Mac 睡眠或断网时无法持续接收；要全天在线，请使用持续在线的服务器。启动 wrapper 显式加载需要的 nvm 环境，不依赖交互 shell 配置。

## PM2

```bash
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup
pm2 status
pm2 logs im-metaagent
```

配置只启动一个接收实例。版本化安装建议从稳定的 `current` 路径启动；更新后用 PM2 重启，不要同时启用 systemd。PM2 的开机启动需要按 `pm2 startup` 输出完成配置。

## 运行限制

同一个 Bot 账号只保持一个消息接收服务；不同机器上的任务文件不会自动同步。Token 可持久化，但失效后需要重新扫码。1.2.0 使用独立 supervisor 保存执行回执；当前 systemd/launchd 模板允许工作进程跨消息服务重启存活，升级模板后需重新安装服务。PM2 或外部工具强制杀进程树时，异常执行标记 unknown，核验后显式恢复；独立 tmux manager 的任务状态仍可读取。停止机器人不等于取消已提交任务。
