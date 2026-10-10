import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectReleaseFiles, sha256, verifyRelease } from './release-files.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('A release version is required');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
await fs.mkdir(output, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'im-metaagent-pack-'));
const folder = `im-metaagent-${pkg.version}`;
const archiveName = `${folder}.tar.gz`;
try {
  const destination = path.join(temp, folder);
  await fs.mkdir(destination);
  const files = [];
  for (const relative of await collectReleaseFiles(root)) {
    const source = path.join(root, relative), target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target); await fs.chmod(target, (await fs.stat(source)).mode & 0o777);
    const bytes = await fs.readFile(target);
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { format: 1, name: 'im-metaagent', version: pkg.version, createdAt: new Date().toISOString(), node: pkg.engines.node, iLinkVersion: '2.4.9', requiredRuntime: '>=0.11.3', runtimeIncluded: false, files };
  await fs.writeFile(path.join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyRelease(destination);
  const archive = path.join(output, archiveName);
  const result = spawnSync('tar', ['-czf', archive, '-C', temp, folder], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Archive creation failed');
  const checksum = sha256(await fs.readFile(archive));
  await fs.writeFile(path.join(output, `${folder}.sha256`), `${checksum}  ${archiveName}\n`);
  await fs.writeFile(path.join(output, `${folder}.manifest.json`), JSON.stringify({ ...manifest, archive: { name: archiveName, bytes: (await fs.stat(archive)).size, sha256: checksum } }, null, 2) + '\n');
  console.log(JSON.stringify({ archive, checksum, files: files.length, bytes: (await fs.stat(archive)).size }));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
