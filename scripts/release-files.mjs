import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const ROOT_FILES = ['package.json', 'package-lock.json', '.env.example', 'README.md', 'README-standalone.md', 'weixin-bot-api.md', 'protocol.md', 'INSTALL.md', 'weixin-meta-agent.mjs', 'weixin-login-check.mjs', 'wechat-claude-bridge.mjs'];
export const SOURCE_DIRS = ['src', 'scripts', 'deploy', 'docs', 'test', 'packages'];
export function allowedFile(relative) {
  return typeof relative === 'string' && !relative.includes('\\') && !path.posix.isAbsolute(relative)
    && !relative.split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules' || part === '.git' || part === '.DS_Store' || part === 'logs' || part === 'accounts' || part === '.env' || (part.startsWith('.env.') && relative !== '.env.example') || part.endsWith('.log'))
    && (ROOT_FILES.includes(relative) || relative === '.gitignore' || SOURCE_DIRS.some(dir => relative.startsWith(dir + '/')));
}
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export async function collectReleaseFiles(root) {
  const files = [...ROOT_FILES];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (['node_modules', '.git', '.DS_Store', 'logs', 'accounts'].includes(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.') || entry.name.endsWith('.log')) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release source must not contain symlinks: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) { if (!allowedFile(child)) throw new Error(`Excluded release path: ${child}`); files.push(child); }
    }
  }
  for (const dir of SOURCE_DIRS) await walk(dir);
  return files.sort();
}
export async function verifyRelease(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.name !== 'im-metaagent' || pkg.name !== manifest.name || manifest.version !== pkg.version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) || manifest.runtimeIncluded !== false || !Array.isArray(manifest.files)) throw new Error('Invalid IM-only release manifest');
  if (pkg.dependencies?.['@meta-agent/runtime'] || pkg.optionalDependencies?.['@meta-agent/runtime']) throw new Error('IM release must use an external meta-agent runtime');
  const seen = new Set();
  for (const record of manifest.files) {
    if (!allowedFile(record.path) || seen.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error('Invalid release file entry');
    seen.add(record.path);
    let resolved = root;
    for (const part of record.path.split('/')) { resolved = path.join(resolved, part); if ((await fs.lstat(resolved)).isSymbolicLink()) throw new Error('Release file crosses a symlink'); }
    const bytes = await fs.readFile(resolved);
    if (sha256(bytes) !== record.sha256 || bytes.length !== record.bytes) throw new Error(`Release integrity mismatch: ${record.path}`);
  }
  for (const required of [...ROOT_FILES, 'deploy/start.sh', 'scripts/install-release.mjs']) if (!seen.has(required)) throw new Error(`Required release file absent: ${required}`);
  return manifest;
}
