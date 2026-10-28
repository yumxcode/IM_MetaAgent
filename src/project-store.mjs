import fs from 'node:fs';
import path from 'node:path';
import { digest } from './durable-store.mjs';

export function validateProjectName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u.test(value)) throw new Error('项目名仅允许文字、数字、下划线、点和连字符，最多 80 字符，且不能以点开头。');
  return value;
}
export function projectPath(root, owner, name) {
  validateProjectName(name);
  const base = path.join(root, 'projects', digest(owner).slice(0, 24));
  const realRoot = fs.realpathSync(root), realBase = containedDirectory(root, base);
  if (!realBase.startsWith(realRoot + path.sep)) throw new Error('项目路径越界');
  const target = path.join(realBase, name);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('项目目录不能是符号链接');
  return target;
}
export function validateCloneUrl(url) {
  if (typeof url !== 'string' || !/^(?:https?:\/\/|ssh:\/\/|git@)[^\s\x00]+$/.test(url)) throw new Error('仅支持 HTTPS/HTTP/SSH Git 地址。');
  return url;
}

/** Resolve every directory before host-side writes, including agent-created parents. */
export function containedDirectory(root, directory) {
  const base = path.resolve(root), target = path.resolve(directory), relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('工作目录越界');
  let cursor = fs.realpathSync(base);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('工作路径包含符号链接或非目录');
  }
  return cursor;
}
