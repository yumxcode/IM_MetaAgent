import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { verifyRelease } from './release-files.mjs';
import { assertSupportedNode } from '../src/node-support.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code})`)));
  });
}
async function readLink(target, name) {
  const link = path.join(target, name);
  if (!await exists(link)) return null;
  if (!(await fs.lstat(link)).isSymbolicLink()) throw new Error(`${link} must be a symlink; use a separate installation directory for an old checkout`);
  return path.resolve(target, await fs.readlink(link));
}
async function setLink(target, name, destination) {
  const link = path.join(target, name);
  if (!destination) { if (await exists(link)) await fs.unlink(link); return; }
  const temp = `${link}.${randomUUID()}.tmp`;
  try {
    await fs.symlink(path.relative(target, destination), temp);
    await fs.rename(temp, link);
  } finally { if (await exists(temp)) await fs.unlink(temp); }
}
async function locked(target, operation) {
  await fs.mkdir(target, { recursive: true });
  const lock = path.join(target, '.install-lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another update is in progress: ${lock}. Remove this directory only after confirming that installer has exited.`);
    throw error;
  }
  try { return await operation(); } finally { await fs.rmdir(lock); }
}
const installDependencies = (directory, offline) => run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], directory);
const checkInstallation = directory => run(process.execPath, ['scripts/check-syntax.mjs'], directory);
const restartService = current => run('bash', ['deploy/install-linux.sh'], current, { ...process.env, IM_METAAGENT_PROJECT_DIR: current });

export async function installRelease({ source = sourceRoot, target = path.join(os.homedir(), 'apps', 'IM_MetaAgent'), offline = false, service = false, dependencies = installDependencies, check = checkInstallation, restart = restartService } = {}) {
  source = path.resolve(source); target = path.resolve(target);
  const manifest = await verifyRelease(source);
  return locked(target, async () => {
    const oldCurrent = await readLink(target, 'current');
    const oldPrevious = await readLink(target, 'previous');
    const shared = path.join(target, 'shared');
    await fs.mkdir(path.join(shared, 'logs'), { recursive: true });
    const envPath = path.join(shared, '.env');
    if (!await exists(envPath)) {
      const legacy = path.join(target, '.env');
      const previousEnv = oldCurrent && path.join(oldCurrent, '.env');
      const contents = await fs.readFile(await exists(legacy) ? legacy : previousEnv && await exists(previousEnv) ? previousEnv : path.join(source, '.env.example'));
      await fs.writeFile(envPath, contents, { mode: 0o600, flag: 'wx' });
    }
    await fs.mkdir(path.join(target, 'releases'), { recursive: true });
    const candidate = await fs.mkdtemp(path.join(target, 'releases', `${manifest.version}-`));
    for (const record of manifest.files) {
      const input = path.join(source, record.path), output = path.join(candidate, record.path);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(input, output);
      await fs.chmod(output, (await fs.stat(input)).mode & 0o777);
    }
    await fs.copyFile(path.join(source, 'release-manifest.json'), path.join(candidate, 'release-manifest.json'));
    await verifyRelease(candidate);
    await fs.symlink('../../shared/.env', path.join(candidate, '.env'));
    await fs.symlink('../../shared/logs', path.join(candidate, 'logs'));
    await dependencies(candidate, offline);
    await check(candidate);
    await setLink(target, 'previous', oldCurrent);
    await setLink(target, 'current', candidate);
    try {
      if (service) await restart(path.join(target, 'current'));
    } catch (error) {
      await setLink(target, 'current', oldCurrent);
      await setLink(target, 'previous', oldPrevious);
      if (oldCurrent) {
        try { await restart(path.join(target, 'current')); } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'Update failed; code was restored but the old service could not restart');
        }
      }
      throw new Error('Update failed; the previous release has been restored', { cause: error });
    }
    return { target, current: candidate, previous: oldCurrent, version: manifest.version, service };
  });
}

export async function rollbackRelease({ target = path.join(os.homedir(), 'apps', 'IM_MetaAgent'), service = false, check = checkInstallation, restart = restartService } = {}) {
  target = path.resolve(target);
  return locked(target, async () => {
    const current = await readLink(target, 'current'), previous = await readLink(target, 'previous');
    if (!current || !previous) throw new Error('No previous release is available');
    await verifyRelease(previous);
    await check(previous);
    await setLink(target, 'current', previous);
    try { if (service) await restart(path.join(target, 'current')); } catch (error) {
      await setLink(target, 'current', current);
      try { await restart(path.join(target, 'current')); } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Rollback failed; the original code was restored but its service could not restart');
      }
      throw new Error('Rollback failed; the original release has been restored', { cause: error });
    }
    await setLink(target, 'previous', current);
    return { target, current: previous, previous: current, service };
  });
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('node scripts/install-release.mjs [TARGET] [--service | --no-service] [--offline] [--rollback]\nDefault: $HOME/apps/IM_MetaAgent, without service restart. No meta-agent runtime is installed.');
    } else {
      const flags = new Set(['--service', '--no-service', '--offline', '--rollback']);
      if (args.some(arg => arg.startsWith('-') && !flags.has(arg)) || args.filter(arg => !arg.startsWith('-')).length > 1 || (args.includes('--service') && args.includes('--no-service'))) throw new Error('Invalid arguments; use --help');
      assertSupportedNode();
      const options = { target: args.find(arg => !arg.startsWith('-')), service: args.includes('--service'), offline: args.includes('--offline') };
      const result = await (args.includes('--rollback') ? rollbackRelease(options) : installRelease(options));
      console.log(JSON.stringify(result, null, 2));
      if (!options.service) console.log('Service was not restarted. Configure shared/.env, check your external runtime, log in, then run deploy/install-linux.sh from current/.');
    }
  } catch (error) { console.error(error.stack); if (error.cause) console.error(error.cause.message); process.exitCode = 1; }
}
