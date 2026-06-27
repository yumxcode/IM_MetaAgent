/**
 * PM2 进程守护配置（跨平台备选方案）
 *
 * 适用场景：
 *  - Linux 服务器（systemd 也可，pm2 更贴合 Node 生态）
 *  - 不想用 launchd 的 macOS 用户
 *  - 需要集群/内存监控等高级功能
 *
 * 用法:
 *   npm install -g pm2
 *   pm2 start deploy/pm2/ecosystem.config.cjs
 *   pm2 save                    # 保存进程列表
 *   pm2 startup                 # 生成开机自启脚本（按提示执行）
 *
 * 常用:
 *   pm2 status / pm2 logs im-metaagent / pm2 restart im-metaagent
 *   pm2 delete im-metaagent
 */
module.exports = {
  apps: [{
    name: 'im-metaagent',
    script: 'weixin-meta-agent.mjs',
    cwd: __dirname + '/..',

    instances: 1,
    exec_mode: 'fork',

    // 崩溃自动重启
    autorestart: true,
    max_restarts: 10,            // 时间窗口内最大重启次数
    min_uptime: '10s',           // 启动后存活 <10s 视为异常启动（不计入健康）
    restart_delay: 5000,         // 基础重启延迟
    exp_backoff_restart_delay: 200, // 指数退避（ms 基数），避免疯狂重启

    // 内存超限自动重启（防泄漏）
    max_memory_restart: '1G',

    // 日志
    out_file: './logs/im-metaagent.out.log',
    error_file: './logs/im-metaagent.err.log',
    merge_logs: true,
    time: true,                  // 日志加时间戳
  }],
};
