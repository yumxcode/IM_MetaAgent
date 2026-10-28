/**
 * Which files an Auto run produced for the user.
 *
 * Declared deliverables come from the public CLI JSONL stream (task_journal
 * kind=artifact / artifacts_register). When a run declares nothing, files of
 * document/media types modified during the run are used instead. Every path is
 * resolved inside the task workspace: a model-written path can never make the
 * bot upload ~/.ssh or anything else outside it.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.mov', '.mp3', '.wav', '.zip', '.epub']);
const SKIP_DIRS = new Set(['node_modules', 'im-inputs', '__pycache__', 'venv', '.venv']);

function asPaths(value) {
  if (Array.isArray(value)) return value.flatMap(asPaths);
  if (typeof value === 'string') return value.split(/\n|,(?=\s*[\w./~-])/).map(s => s.trim()).filter(Boolean);
  if (value && typeof value === 'object' && typeof value.path === 'string') return [value.path];
  return [];
}

/** Extract declared deliverable paths from one runtime event (or nothing). */
export function declaredPathsFromEvent(event) {
  if (event?.type !== 'tool_use') return [];
  const input = event.toolInput || event.input || {};
  if (event.toolName === 'task_journal') {
    const kind = String(input.kind || '').toLowerCase();
    const explicit = input.paths ?? input.artifacts ?? input.files;
    if (kind && !['artifact', '产出', '交付', 'deliverable', 'file'].includes(kind) && explicit === undefined) return [];
    return asPaths(explicit ?? (kind === 'artifact' ? input.path : undefined));
  }
  if (event.toolName === 'artifacts_register') return asPaths(input.paths ?? input.artifacts ?? input.files);
  return [];
}

/** Resolve `candidate` to a real regular file inside `workspace`, or null. */
export function containedFile(workspace, candidate) {
  try {
    const root = fs.realpathSync(workspace);
    const raw = String(candidate).replace(/^file:\/\//, '');
    const resolved = fs.realpathSync(path.isAbsolute(raw) ? raw : path.join(root, raw));
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch { return null; }
}

/** Document/media files modified at or after `since` (ms), newest first. */
export function scanRecentDocuments(workspace, since, { maxDepth = 4, maxEntries = 5000 } = {}) {
  const found = []; let seen = 0;
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1); continue; }
      if (!entry.isFile() || !DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try { const stat = fs.statSync(full); if (stat.mtimeMs >= since) found.push({ path: full, mtimeMs: stat.mtimeMs }); } catch { /* vanished */ }
    }
  };
  walk(workspace, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(item => item.path);
}

/**
 * Final list of deliverables for one run.
 * @returns {{ files: string[], source: 'declared'|'scan'|'none' }}
 */
export function collectDeliverables({ workspace, declared = [], since, limit = 20 }) {
  const unique = new Set();
  for (const candidate of declared) { const file = containedFile(workspace, candidate); if (file) unique.add(file); }
  if (unique.size) return { files: [...unique].slice(0, limit), source: 'declared' };
  if (!Number.isFinite(since)) return { files: [], source: 'none' };
  const scanned = scanRecentDocuments(workspace, since).slice(0, limit);
  return { files: scanned, source: scanned.length ? 'scan' : 'none' };
}

export function mediaKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.mp4', '.mov'].includes(ext)) return 'video';
  return 'file';
}
