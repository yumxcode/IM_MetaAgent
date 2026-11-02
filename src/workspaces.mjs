/**
 * Folders the assistant may look at and auto tasks may work in.
 *
 * IM_WORKSPACE_ROOTS lists the roots (e.g. ~/code,~/work). Every path is
 * resolved with realpath and must land strictly inside one root, so a symlink
 * cannot lead outside. Reads are metadata only: names, README/package
 * excerpts, git branch/remote/status. Secrets-looking files are never read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', 'target', '.next', '.cache', 'Library']);
const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u;
const MAX_LIST = 200;

export function expandHome(value, home = os.homedir()) {
  const raw = String(value || '').trim();
  return raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
}
export function displayPath(value, home = os.homedir()) {
  return value === home ? '~' : value.startsWith(home + path.sep) ? `~/${value.slice(home.length + 1)}` : value;
}

/** Parse IM_WORKSPACE_ROOTS. Missing or non-directory entries are reported, not fatal. */
export function parseRoots(raw, { home = os.homedir() } = {}) {
  const roots = [], problems = [];
  for (const item of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const expanded = expandHome(item, home);
    if (!path.isAbsolute(expanded)) { problems.push(`${item}：必须是绝对路径或 ~/ 开头`); continue; }
    try {
      const real = fs.realpathSync(expanded);
      if (!fs.statSync(real).isDirectory()) { problems.push(`${item}：不是目录`); continue; }
      if (real === path.parse(real).root || real === fs.realpathSync(home)) { problems.push(`${item}：不允许把根目录或整个家目录作为白名单`); continue; }
      if (!roots.includes(real)) roots.push(real);
    } catch { problems.push(`${item}：不存在`); }
  }
  return { roots, problems };
}

/** The real path of `candidate` when it lies strictly inside one root (roots themselves only when allowRoot). */
export function resolveInRoots(roots, candidate, { allowRoot = false, home = os.homedir() } = {}) {
  if (!roots.length) throw new Error('未配置 IM_WORKSPACE_ROOTS，不能访问电脑上的文件夹');
  const expanded = expandHome(candidate, home);
  if (!path.isAbsolute(expanded)) throw new Error('请使用绝对路径或 ~/ 开头的路径');
  let real;
  try { real = fs.realpathSync(expanded); } catch { throw new Error(`路径不存在：${candidate}`); }
  for (const root of roots) {
    const rel = path.relative(root, real);
    if (rel === '' ? allowRoot : !rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (!fs.statSync(real).isDirectory()) throw new Error(`不是文件夹：${candidate}`);
      return { real, root };
    }
  }
  throw new Error(`路径不在允许的范围内：${candidate}（允许：${roots.map(r => displayPath(r, home)).join('、')}）`);
}

/** Validate a folder that does not exist yet; nothing is created here. */
export function planCreate(roots, parent, name, { home = os.homedir() } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('文件夹名仅允许文字、数字、下划线、点和连字符，最多 80 字符，且不能以点开头');
  const { real } = resolveInRoots(roots, parent, { allowRoot: true, home });
  const target = path.join(real, name);
  if (fs.existsSync(target)) throw new Error(`文件夹已存在：${displayPath(target, home)}（如要使用请直接选它）`);
  return target;
}

function readHead(file, bytes = 8192) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(bytes); const n = fs.readSync(fd, buffer, 0, bytes, 0); return buffer.subarray(0, n).toString('utf8'); }
  catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readmeExcerpt(dir, max = 400) {
  for (const name of ['README.md', 'README.zh.md', 'README', 'readme.md', 'README.txt']) {
    const text = readHead(path.join(dir, name));
    if (text) return text.replace(/<[^>]+>/g, ' ').replace(/[#>*`|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  return '';
}
function packageInfo(dir) {
  try {
    const pkg = JSON.parse(readHead(path.join(dir, 'package.json'), 65536));
    return { name: typeof pkg.name === 'string' ? pkg.name : undefined, description: typeof pkg.description === 'string' ? pkg.description.slice(0, 200) : undefined,
      scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).slice(0, 20) : undefined };
  } catch { /* not a node project */ }
  const py = readHead(path.join(dir, 'pyproject.toml'), 16384);
  if (py) {
    const name = /^\s*name\s*=\s*["']([^"']+)/m.exec(py)?.[1], description = /^\s*description\s*=\s*["']([^"']+)/m.exec(py)?.[1];
    if (name || description) return { name, description: description?.slice(0, 200) };
  }
  return {};
}
/** Branch and origin from .git files; credentials in remote URLs are stripped. */
export function gitInfo(dir) {
  const git = path.join(dir, '.git');
  try { if (!fs.statSync(git).isDirectory()) return null; } catch { return null; }
  const head = readHead(path.join(git, 'HEAD'), 512).trim();
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] || (head ? head.slice(0, 8) : undefined);
  const config = readHead(path.join(git, 'config'), 16384);
  const remote = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1]?.replace(/\/\/[^/@\s]+@/, '//');
  return { branch, ...(remote ? { remote } : {}) };
}
function run(args, cwd, timeoutMs = 4000) {
  return new Promise(resolve => execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout))));
}
/** Uncommitted change count and recent commits (bounded by a timeout). */
export async function gitStatus(dir) {
  if (!gitInfo(dir)) return null;
  const [status, log] = await Promise.all([run(['status', '--porcelain'], dir), run(['log', '-5', '--pretty=%h %ad %s', '--date=short'], dir)]);
  return { dirty: status === null ? null : status.split('\n').filter(Boolean).length, recent: log ? log.split('\n').filter(Boolean) : [] };
}

function visibleChildren(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map(e => e.name).sort((a, b) => a.localeCompare(b));
}
function describe(dir, home) {
  let mtimeMs = 0; try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { /* vanished */ }
  const git = gitInfo(dir), pkg = packageInfo(dir);
  return { path: displayPath(dir, home), name: path.basename(dir), ...(git ? { git } : {}), ...(pkg.name || pkg.description ? { package: { name: pkg.name, description: pkg.description } } : {}), modified: new Date(mtimeMs).toISOString().slice(0, 10) };
}

/** Roots with their first-level folders, or the folders under one path. */
export function listWorkspaces(roots, target, { home = os.homedir() } = {}) {
  if (!target) {
    return { roots: roots.map(root => ({ path: displayPath(root, home), folders: visibleChildren(root).slice(0, MAX_LIST) })) };
  }
  const { real } = resolveInRoots(roots, target, { allowRoot: true, home });
  const names = visibleChildren(real);
  return { path: displayPath(real, home), folders: names.slice(0, MAX_LIST).map(name => describe(path.join(real, name), home)), ...(names.length > MAX_LIST ? { truncated: names.length } : {}) };
}

/** One folder in more detail: README, package, git status, a shallow tree. */
export async function peekWorkspace(roots, target, { home = os.homedir() } = {}) {
  const { real } = resolveInRoots(roots, target, { allowRoot: true, home });
  const tree = []; let count = 0;
  const walk = (dir, depth, prefix) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      if (++count > 80) return;
      tree.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && depth < 1) walk(path.join(dir, e.name), depth + 1, `${prefix}  `);
    }
  };
  walk(real, 0, '');
  const pkg = packageInfo(real);
  return { path: displayPath(real, home), readme: readmeExcerpt(real, 2000), ...(pkg.name || pkg.description || pkg.scripts ? { package: pkg } : {}),
    git: gitInfo(real) ? { ...gitInfo(real), ...(await gitStatus(real)) } : null, tree, ...(count > 80 ? { treeTruncated: true } : {}) };
}

/** CJK bigrams plus lowercase latin words. */
export function searchTokens(text) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || [];
  const tokens = new Set(words.flatMap(w => [w, ...w.split(/[_.-]+/).filter(p => p.length > 1)]));
  for (const run of lower.match(/[㐀-鿿]+/g) || []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

/** A cached shallow index of the roots, searched by meaning-bearing tokens. */
export class WorkspaceCatalog {
  constructor(roots, { depth = 2, ttlMs = 10 * 60 * 1000, maxEntries = 400, home = os.homedir(), now = Date.now } = {}) {
    Object.assign(this, { roots, depth, ttlMs, maxEntries, home, now });
    this.cache = null; this.builtAt = 0;
  }
  entries() {
    if (this.cache && this.now() - this.builtAt < this.ttlMs) return this.cache;
    const out = [];
    const walk = (dir, depth) => {
      for (const name of visibleChildren(dir)) {
        if (out.length >= this.maxEntries) return;
        const full = path.join(dir, name);
        let real; try { real = fs.realpathSync(full); } catch { continue; }
        if (!this.roots.some(root => real.startsWith(root + path.sep))) continue;
        const git = gitInfo(real), pkg = packageInfo(real), readme = readmeExcerpt(real);
        let mtimeMs = 0; try { mtimeMs = fs.statSync(real).mtimeMs; } catch { /* vanished */ }
        const project = Boolean(git || pkg.name || readme);
        out.push({ real, name, git, pkg, readme, mtimeMs, project });
        // Inside a project its subfolders are implementation detail, not candidates.
        if (depth < this.depth && !project) walk(real, depth + 1);
      }
    };
    for (const root of this.roots) walk(root, 1);
    this.cache = out; this.builtAt = this.now();
    return out;
  }
  invalidate() { this.cache = null; }
  /** Ranked candidates. `used` maps real path → goals of tasks that worked there. */
  search(query, { used = new Map(), limit = 10 } = {}) {
    const tokens = searchTokens(query);
    const scored = this.entries().map(entry => {
      const goals = used.get(entry.real) || [];
      const name = `${entry.name} ${entry.pkg.name || ''}`.toLowerCase();
      const body = `${entry.pkg.description || ''} ${entry.readme} ${entry.git?.remote || ''} ${goals.join(' ')}`.toLowerCase();
      let score = 0;
      for (const token of tokens) { if (name.includes(token)) score += 3; else if (body.includes(token)) score += 1; }
      if (goals.length) score += 0.5;
      return { entry, score, goals };
    });
    const ranked = tokens.length ? scored.filter(s => s.score > 0.5) : scored;
    ranked.sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs);
    return ranked.slice(0, limit).map(({ entry, score, goals }) => ({
      path: displayPath(entry.real, this.home), name: entry.name, ...(tokens.length ? { score } : {}),
      ...(entry.pkg.name || entry.pkg.description ? { package: { name: entry.pkg.name, description: entry.pkg.description } } : {}),
      ...(entry.readme ? { readme: entry.readme.slice(0, 200) } : {}), ...(entry.git ? { git: entry.git } : {}),
      modified: new Date(entry.mtimeMs).toISOString().slice(0, 10), ...(goals.length ? { previousTasks: goals.slice(-3) } : {}),
    }));
  }
}
