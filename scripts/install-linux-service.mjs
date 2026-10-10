import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from './install-release.mjs';
import { assertSupportedNode } from '../src/node-support.mjs';

// systemd expands % specifiers even inside quotes. ExecStart also expands $.
// WorkingDirectory and append: paths are single raw values, not word lists.
function servicePath(value) {
  if (!path.isAbsolute(value) || /[\r\n\0\\]/.test(value)) throw new Error('Invalid service path');
  return value.replace(/%/g, '%%');
}
function quote(value, exec = false) {
  let escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (/[\r\n\0]/.test(escaped)) throw new Error('Invalid service setting');
  if (exec) escaped = escaped.replace(/\$/g, () => '$$');
  return `"${escaped}"`;
}
export function renderService(template, { project, user, home, nodeDir, searchPath = process.env.PATH }) {
  if (!/^[a-zA-Z0-9_.-]+\$?$/.test(user)) throw new Error('Unsupported system username');
  return template
    .replaceAll('__USER__', () => user)
    .replaceAll('__PROJECT_DIR__', () => servicePath(project))
    .replaceAll('__START__', () => quote(path.join(project, 'deploy/start.sh'), true))
    .replaceAll('__LOG_OUT__', () => servicePath(path.join(project, 'logs/im-metaagent.out.log')))
    .replaceAll('__LOG_ERR__', () => servicePath(path.join(project, 'logs/im-metaagent.err.log')))
    .replaceAll('__ENV_HOME__', () => quote(`HOME=${home}`))
    .replaceAll('__ENV_PATH__', () => quote(`PATH=${nodeDir}:${searchPath || '/usr/local/bin:/usr/bin:/bin'}`));
}
export function renderLogrotate(logDir, user, group) {
  if (/[\r\n"\\]/.test(logDir) || !/^[\w.-]+\$?$/.test(user) || !/^[\w.-]+$/.test(group)) throw new Error('Unsupported logrotate setting');
  return `"${logDir}/*.log" {\n    daily\n    maxsize 10M\n    rotate 7\n    compress\n    delaycompress\n    missingok\n    notifempty\n    copytruncate\n    su ${user} ${group}\n}\n`;
}
async function install(project) {
  if (process.platform !== 'linux') throw new Error('systemd installation requires Linux');
  assertSupportedNode();
  if (spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('systemd is required');
  if (!await fs.stat(path.join(project, '.env')).catch(() => null)) throw new Error('Create/configure .env before installing the service');
  const user = os.userInfo().username;
  const group = spawnSync('id', ['-gn'], { encoding: 'utf8' });
  if (group.status !== 0) throw new Error('Cannot resolve the current user group');
  await fs.mkdir(path.join(project, 'logs'), { recursive: true });
  const logDir = await fs.realpath(path.join(project, 'logs'));
  const template = await fs.readFile(path.join(project, 'deploy/systemd/im-metaagent.service'), 'utf8');
  const rendered = renderService(template, { project, user, home: os.homedir(), nodeDir: path.dirname(process.execPath) });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'im-metaagent-service-'));
  const privileged = (command, args) => process.getuid() === 0 ? run(command, args, project) : run('sudo', [command, ...args], project);
  try {
    const serviceFile = path.join(temp, 'im-metaagent.service');
    await fs.writeFile(serviceFile, rendered);
    await privileged('install', ['-m', '644', serviceFile, '/etc/systemd/system/im-metaagent.service']);
    if (spawnSync('logrotate', ['--version'], { stdio: 'ignore' }).status === 0) {
      const rotation = path.join(temp, 'im-metaagent.logrotate');
      await fs.writeFile(rotation, renderLogrotate(logDir, user, group.stdout.trim()));
      await privileged('install', ['-m', '644', rotation, '/etc/logrotate.d/im-metaagent']);
    } else console.log('logrotate 未安装；安装后重新运行此脚本即可启用日志轮转。');
    await privileged('systemctl', ['daemon-reload']);
    await privileged('systemctl', ['enable', 'im-metaagent']);
    await privileged('systemctl', ['reset-failed', 'im-metaagent']);
    await privileged('systemctl', ['restart', 'im-metaagent']);
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (spawnSync('systemctl', ['is-active', '--quiet', 'im-metaagent']).status !== 0) throw new Error(`服务未正常运行；查看 ${logDir}/im-metaagent.err.log`);
    console.log(`服务已启动并启用开机自启：${project}\n运行状态：sudo systemctl status im-metaagent\n消息日志：${logDir}/im-metaagent.err.log\n请再从微信发送 /tasks running 验证收发和任务读取。`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  install(path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url))))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
