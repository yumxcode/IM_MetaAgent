import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
for (const directory of ['src', 'scripts']) {
  for (const name of await fs.readdir(path.join(root, directory))) if (name.endsWith('.mjs')) files.push(path.join(directory, name));
}
for (const name of await fs.readdir(root)) if (name.endsWith('.mjs')) files.push(name);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked: ${files.length} modules`);
