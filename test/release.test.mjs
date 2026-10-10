import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT_FILES, SOURCE_DIRS, allowedFile, collectReleaseFiles, sha256, verifyRelease } from '../scripts/release-files.mjs';
import { installRelease, rollbackRelease } from '../scripts/install-release.mjs';
import { renderService, renderLogrotate } from '../scripts/install-linux-service.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
async function fixture(root, version = '1.1.0') {
  await fs.mkdir(root, { recursive: true });
  for (const dir of SOURCE_DIRS) await fs.mkdir(path.join(root, dir));
  for (const file of [...ROOT_FILES, 'deploy/start.sh', 'scripts/install-release.mjs']) await fs.writeFile(path.join(root, file), `${file}\n`);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'im-metaagent', version, dependencies: { dotenv: '^17.3.1' } }));
  await fs.writeFile(path.join(root, '.env.example'), 'EXAMPLE=1\n');
  const files = [];
  for (const relative of await collectReleaseFiles(root)) {
    const bytes = await fs.readFile(path.join(root, relative));
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { format: 1, name: 'im-metaagent', version, runtimeIncluded: false, files };
  await fs.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  return root;
}
const noSideEffects = { dependencies: async () => {}, check: async () => {} };

test('release file selection excludes configs, logs, dependencies and unrelated root files', async t => {
  const root = await fixture(await temporary(t));
  for (const name of ['.env', '.env.local', 'node_modules', 'logs', 'accounts']) {
    if (name.startsWith('.env')) await fs.writeFile(path.join(root, 'src', name), 'secret');
    else { await fs.mkdir(path.join(root, 'src', name)); await fs.writeFile(path.join(root, 'src', name, 'private'), 'secret'); }
  }
  await fs.writeFile(path.join(root, '.env'), 'ROOT_SECRET=1');
  await fs.writeFile(path.join(root, 'qixi.html'), 'unrelated');
  await fs.writeFile(path.join(root, 'src', 'debug.log'), 'private');
  const files = await collectReleaseFiles(root);
  assert.ok(files.includes('.env.example'));
  assert.ok(!files.some(file => file.includes('private') || file.endsWith('.log') || file === '.env' || file === 'qixi.html' || file.includes('.env.local')));
  for (const invalid of ['../package.json', '/package.json', 'src/../../etc/passwd', 'src//x', 'src\\x', 'src/.env', 'src/.env.example', 'src/accounts/private', 'vendor/runtime.tgz']) assert.equal(allowedFile(invalid), false, invalid);
});

test('manifest rejects altered content, symlink traversal and embedded runtime dependency', async t => {
  const base = await temporary(t), root = await fixture(path.join(base, 'source'));
  await verifyRelease(root);
  await fs.writeFile(path.join(root, 'README.md'), 'tampered');
  await assert.rejects(verifyRelease(root), /integrity mismatch/);
  await fs.writeFile(path.join(root, 'README.md'), 'README.md\n');
  const external = path.join(base, 'external');
  await fs.writeFile(external, 'README.md\n');
  await fs.unlink(path.join(root, 'README.md'));
  await fs.symlink(external, path.join(root, 'README.md'));
  await assert.rejects(verifyRelease(root), /symlink/);
  await fs.unlink(path.join(root, 'README.md'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  pkg.optionalDependencies = { '@meta-agent/runtime': '0.10.16' };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(verifyRelease(root), /external meta-agent runtime/);
});

test('manifest rejects unsafe and duplicate entries and missing required files', async t => {
  const root = await fixture(await temporary(t));
  const manifestPath = path.join(root, 'release-manifest.json');
  const original = JSON.parse(await fs.readFile(manifestPath));
  for (const files of [
    [...original.files, { path: '../private', sha256: '0'.repeat(64), bytes: 0 }],
    [...original.files, original.files[0]],
    original.files.filter(record => record.path !== 'deploy/start.sh'),
  ]) {
    await fs.writeFile(manifestPath, JSON.stringify({ ...original, files }));
    await assert.rejects(verifyRelease(root));
  }
});

test('source symlinks are refused by the packager', async t => {
  const root = await fixture(await temporary(t));
  await fs.symlink('../README.md', path.join(root, 'src', 'link.mjs'));
  await assert.rejects(collectReleaseFiles(root), /symlinks/);
});

test('install imports old configuration, preserves shared data and supports rollback', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'one'));
  const target = path.join(base, 'installed with spaces');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, '.env'), 'EXISTING_SECRET=retained\n');
  const first = await installRelease({ source, target, ...noSideEffects });
  assert.equal(await fs.realpath(path.join(target, 'current')), first.current);
  assert.equal(await fs.readFile(path.join(first.current, '.env'), 'utf8'), 'EXISTING_SECRET=retained\n');
  assert.equal((await fs.stat(path.join(target, 'shared', '.env'))).mode & 0o777, 0o600);
  await fs.writeFile(path.join(target, 'shared/logs/keep.log'), 'kept');
  const next = await fixture(path.join(base, 'two'), '1.1.1');
  const second = await installRelease({ source: next, target, ...noSideEffects });
  assert.equal(second.previous, first.current);
  assert.equal(await fs.readFile(path.join(second.current, '.env'), 'utf8'), 'EXISTING_SECRET=retained\n');
  assert.equal(await fs.readFile(path.join(second.current, 'logs/keep.log'), 'utf8'), 'kept');
  const reverted = await rollbackRelease({ target, check: noSideEffects.check });
  assert.equal(reverted.current, first.current);
  assert.equal(await fs.realpath(path.join(target, 'previous')), second.current);
  await verifyRelease(reverted.current);
});

test('first install creates example config and refuses rollback without a previous release', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'source'));
  const target = path.join(base, 'target');
  await installRelease({ source, target, ...noSideEffects });
  assert.equal(await fs.readFile(path.join(target, 'shared/.env'), 'utf8'), 'EXAMPLE=1\n');
  await assert.rejects(rollbackRelease({ target, check: noSideEffects.check }), /No previous release/);
});

test('dependency/preflight failures do not change the active or previous release', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'source'));
  const target = path.join(base, 'target');
  const first = await installRelease({ source, target, ...noSideEffects });
  const second = await installRelease({ source, target, ...noSideEffects });
  for (const hook of ['dependencies', 'check']) {
    await assert.rejects(installRelease({ source, target, ...noSideEffects, [hook]: async () => { throw new Error('preflight failure'); } }), /preflight failure/);
    assert.equal(await fs.realpath(path.join(target, 'current')), second.current);
    assert.equal(await fs.realpath(path.join(target, 'previous')), first.current);
    await assert.rejects(fs.lstat(path.join(target, '.install-lock')), { code: 'ENOENT' });
  }
});

test('service restart failure restores both links and retries the old service', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'source'));
  const target = path.join(base, 'target');
  const first = await installRelease({ source, target, ...noSideEffects });
  const second = await installRelease({ source, target, ...noSideEffects });
  const restarts = [];
  await assert.rejects(installRelease({ source, target, ...noSideEffects, service: true, restart: async current => {
    restarts.push(await fs.realpath(current));
    if (restarts.length === 1) throw new Error('bad service');
  } }), /previous release has been restored/);
  assert.equal(restarts.length, 2);
  assert.equal(restarts[1], second.current);
  assert.equal(await fs.realpath(path.join(target, 'current')), second.current);
  assert.equal(await fs.realpath(path.join(target, 'previous')), first.current);
});

test('rollback failure restores the original active release', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'source'));
  const target = path.join(base, 'target');
  await installRelease({ source, target, ...noSideEffects });
  const second = await installRelease({ source, target, ...noSideEffects });
  let restarts = 0;
  await assert.rejects(rollbackRelease({ target, check: noSideEffects.check, service: true, restart: async () => {
    if (++restarts === 1) throw new Error('bad service');
  } }), /original release has been restored/);
  assert.equal(restarts, 2);
  assert.equal(await fs.realpath(path.join(target, 'current')), second.current);
});

test('concurrent installers are refused and existing lock is retained', async t => {
  const base = await temporary(t), source = await fixture(path.join(base, 'source'));
  const target = path.join(base, 'target');
  await fs.mkdir(path.join(target, '.install-lock'), { recursive: true });
  await assert.rejects(installRelease({ source, target, ...noSideEffects }), /Another update/);
  assert.ok((await fs.stat(path.join(target, '.install-lock'))).isDirectory());
});

test('systemd template quotes paths and puts startup rate limits in the Unit section', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const template = await fs.readFile(path.join(root, 'deploy/systemd/im-metaagent.service'), 'utf8');
  const rendered = renderService(template, { project: '/srv/IM $x% y/current', user: 'agent', home: '/home/agent', nodeDir: '/opt/node/bin', searchPath: '/usr/bin:/bin' });
  assert.ok(!rendered.includes('__'));
  assert.ok(rendered.includes('ExecStart=/bin/bash "/srv/IM $$x%% y/current/deploy/start.sh"'));
  assert.ok(rendered.indexOf('StartLimitIntervalSec=300') < rendered.indexOf('[Service]'));
  assert.ok(rendered.includes('Environment="HOME=/home/agent"'));
  assert.ok(rendered.includes('WorkingDirectory=/srv/IM $x%% y/current'));
  assert.ok(rendered.includes('StandardError=append:/srv/IM $x%% y/current/logs/im-metaagent.err.log'));
  assert.throws(() => renderService(template, { project: '/srv/path\nUser=root', user: 'agent', home: '/home/agent', nodeDir: '/opt/node' }));
  const rotate = renderLogrotate('/srv/IM agent/shared/logs', 'agent', 'agent');
  assert.ok(rotate.includes('"/srv/IM agent/shared/logs/*.log"'));
  assert.ok(rotate.includes('su agent agent'));
});

test('real archive contains only IM, checksums match and extracted manifest verifies', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url)), base = await temporary(t);
  const result = spawnSync(process.execPath, ['scripts/package-release.mjs', base], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  const folder = `im-metaagent-${pkg.version}`, archive = path.join(base, folder + '.tar.gz');
  const actual = sha256(await fs.readFile(archive));
  assert.equal((await fs.readFile(path.join(base, folder + '.sha256'), 'utf8')).split(' ')[0], actual);
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  for (const name of list.stdout.trim().split('\n')) {
    assert.ok(name.startsWith(folder + '/'));
    assert.ok(!/(^|\/)(node_modules|vendor|logs|accounts|\.git|\.env|\.env\.local)(\/|$)/.test(name), name);
    assert.ok(!name.split('/').some(part => part.startsWith('._')), name);
  }
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', base]).status, 0);
  const manifest = await verifyRelease(path.join(base, folder));
  assert.equal(manifest.runtimeIncluded, false);
  const lock = JSON.parse(await fs.readFile(path.join(base, folder, 'package-lock.json')));
  assert.equal(lock.packages['node_modules/@meta-agent/runtime'], undefined);
  assert.ok(!Object.keys(lock.packages).some(key => key.startsWith('packages/')), 'official references must not participate in dependency engine validation');
  assert.equal(pkg.optionalDependencies?.['@meta-agent/runtime'], undefined);
});

test('installer entry point works through a stable symlink', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url)), base = await temporary(t);
  const link = path.join(base, 'current');
  await fs.symlink(root, link);
  const result = spawnSync(process.execPath, [path.join(link, 'scripts/install-release.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No meta-agent runtime is installed/);
});

test('start wrapper preserves the selected supported Node when the external CLI is absent', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url)), base = await temporary(t);
  await fs.mkdir(path.join(base, 'deploy'));
  await fs.mkdir(path.join(base, 'src'));
  await fs.mkdir(path.join(base, 'fake-nvm'));
  await fs.copyFile(path.join(root, 'deploy/start.sh'), path.join(base, 'deploy/start.sh'));
  await fs.copyFile(path.join(root, 'src/node-support.mjs'), path.join(base, 'src/node-support.mjs'));
  await fs.writeFile(path.join(base, 'fake-nvm/nvm.sh'), 'export IM_NVM_WAS_LOADED=yes\n');
  await fs.writeFile(path.join(base, 'weixin-meta-agent.mjs'), 'console.log(JSON.stringify({ node: process.versions.node, nvmLoaded: process.env.IM_NVM_WAS_LOADED ?? null }));\n');
  const result = spawnSync('/bin/bash', [path.join(base, 'deploy/start.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NVM_DIR: path.join(base, 'fake-nvm') } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.node, process.versions.node);
  assert.equal(output.nvmLoaded, null);
});
