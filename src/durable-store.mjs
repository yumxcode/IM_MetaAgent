import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const identityOf = msg => JSON.stringify([msg.accountId, msg.fromUserId, msg.groupId || 'private']);
export function readState(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function fsyncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // File fsync plus directory fsync gives the queue an actual durable boundary.
  fsyncDirectory(path.dirname(file));
}
export function atomicWrite(file, value) { atomicWriteText(file, JSON.stringify(value)); }
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function copyDurableFile(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination);
  fsyncDirectory(path.dirname(destination));
}

const EMPTY_STATE = () => ({ version: 1, nextTask: 1, inbox: {}, executions: {}, tasks: {}, contacts: {}, conversations: {}, outbox: {}, pendingMedia: {}, projects: {}, selectedProjects: {} });
const SEP = '\u0000';
const isObject = value => value !== null && typeof value === 'object';

/** One journal line = one committed group of record writes: {"o":[[collection|null, key, value?], ...]}. */
function applyOps(state, ops) {
  for (const op of ops) {
    const [collection, key] = op;
    if (collection === null) { if (op.length > 2) state[key] = op[2]; else delete state[key]; continue; }
    if (op.length > 2) { if (!isObject(state[collection])) state[collection] = {}; state[collection][key] = op[2]; }
    else if (isObject(state[collection])) delete state[collection][key];
  }
}
/** Snapshot plus journal. A torn last line (crash mid-append) is an uncommitted group and is ignored. */
function loadFiles(file, journal) {
  const state = readState(file, EMPTY_STATE());
  let text = '';
  try { text = fs.readFileSync(journal, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = text.split('\n');
  let replayed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); }
    catch (error) {
      const last = lines.slice(i + 1).every(line => !line);
      if (last) break; // torn tail: never acknowledged
      throw new Error(`IM 状态日志第 ${i + 1} 行损坏，请核查 ${journal}`);
    }
    if (!Array.isArray(entry?.o)) throw new Error(`IM 状态日志第 ${i + 1} 行格式错误`);
    applyOps(state, entry.o); replayed++;
  }
  return { state, replayed, journalBytes: Buffer.byteLength(text) };
}
/** Read-only view of a store directory (snapshot + journal), for CLI inspection without taking the lock. */
export function loadState(root) {
  return loadFiles(path.join(root, 'state.json'), path.join(root, 'state.journal')).state;
}

/**
 * Durable state for the bot: a JSON snapshot plus an append-only journal.
 *
 * update(fn) runs `fn` against a tracking view of the live state. Every write
 * (at any depth) marks its record — `state.<collection>[<key>]`, or a
 * top-level key — as dirty; the record's previous value is cloned on first
 * touch so a throwing update is rolled back exactly. Committing appends only
 * the dirty records (one JSON line, one fsync); the snapshot is rewritten
 * when the journal grows past a threshold, on close, and after replaying a
 * journal at startup. Cost per update is proportional to what changed, not to
 * the size of the state.
 *
 * Durability: update() commits before returning unless inside batch(), which
 * commits once at its end, or called with { lazy: true }, which commits with
 * the next commit or within `lazyMs`. Callers flush() before any external side
 * effect that must not be repeated after a crash.
 *
 * Writes must go through the `state` argument. Objects created inside the
 * update and stored into the state may be mutated through local references
 * until the update returns (their record is already dirty). In verify mode
 * (IM_STORE_VERIFY=1, used by the test suite) every commit checks that the
 * journal reproduces the in-memory state, which catches untracked writes.
 */
export class DurableStore {
  constructor(root, { lock = true, lazyMs = 2000, compactBytes = 2 * 1024 * 1024, compactLines = 5000, verify = process.env.IM_STORE_VERIFY === '1' } = {}) {
    this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(this.root);
    this.lockFile = path.join(this.root, 'consumer.lock');
    this.lockToken = randomUUID();
    if (lock) {
      try { this.acquire(); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize stale-lock recovery: two restarters must never unlink each other's new lock.
        const recoveryFile = `${this.lockFile}.recovery`;
        let recovery;
        try { recovery = fs.openSync(recoveryFile, 'wx', 0o600); }
        catch { throw new Error('IM 锁恢复正在进行或上次恢复中断，请核查状态目录。'); }
        try {
          const prior = readState(this.lockFile, null);
          if (prior && (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string')) throw new Error('IM 锁记录损坏，请核查状态目录。');
          if (prior && processAlive(prior.pid)) throw new Error('已有 IM 实例使用此状态目录，不能重复启动。');
          if (prior) fs.unlinkSync(this.lockFile);
          this.acquire();
        } finally { fs.closeSync(recovery); fs.unlinkSync(recoveryFile); }
      }
    }
    this.locked = lock;
    this.file = path.join(this.root, 'state.json');
    this.journal = path.join(this.root, 'state.journal');
    Object.assign(this, { lazyMs, compactBytes, compactLines, verify });
    this.pending = new Map(); this.batchDepth = 0; this.txn = null; this.lazyTimer = null; this.listeners = [];
    this.stats = { commits: 0, journalBytesWritten: 0, snapshots: 0, snapshotBytes: 0 };
    try {
      const loaded = loadFiles(this.file, this.journal);
      if (loaded.state.version !== 1) throw new Error('不支持的 IM 状态版本');
      this.state = loaded.state;
      this.journalLines = 0; this.journalBytes = loaded.journalBytes;
      // Fold a replayed (or torn) journal into a fresh snapshot before appending to it.
      if (loaded.journalBytes > 0 || !fs.existsSync(this.file)) this.snapshot();
      this.fd = fs.openSync(this.journal, 'a', 0o600);
      if (this.verify) this.shadow = JSON.parse(JSON.stringify(this.state));
    } catch (error) { this.close(); throw error; }
  }
  acquire() { const fd = fs.openSync(this.lockFile, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  /** Called with (collection|null, key, value|undefined) after every successful update, before it is journaled. */
  onChange(listener) { this.listeners.push(listener); }

  update(fn, { lazy = false } = {}) {
    if (this.txn) return fn(this.txn.root); // nested: part of the outer update
    const txn = this.txn = new Transaction(this.state);
    let result;
    try { result = fn(txn.root); }
    catch (error) { txn.rollback(); throw error; }
    finally { this.txn = null; }
    if (!txn.dirty.size) return result;
    for (const [key, entry] of txn.dirty) this.pending.set(key, entry);
    for (const [collection, key] of txn.dirty.values()) {
      const value = collection === null ? this.state[key] : this.state[collection]?.[key];
      for (const listener of this.listeners) listener(collection, key, value);
    }
    if (this.batchDepth === 0) {
      if (lazy) this.scheduleLazy(); else this.flush();
    }
    return result;
  }
  /** Group several updates into one commit (still applied to memory one by one). */
  batch(fn) {
    this.batchDepth++;
    try { return fn(); }
    finally { if (--this.batchDepth === 0) this.flush(); }
  }
  scheduleLazy() {
    if (this.lazyTimer || !this.fd) return;
    this.lazyTimer = setTimeout(() => { this.lazyTimer = null; try { this.flush(); } catch { /* retried on the next commit */ } }, this.lazyMs);
    this.lazyTimer.unref?.();
  }
  /** Append every pending record as one journal line (one fsync). */
  flush() {
    if (!this.pending.size || !this.fd) return;
    if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = null; }
    const top = [], records = [];
    for (const [collection, key] of this.pending.values()) {
      if (collection === null) top.push(key in this.state ? [null, key, this.state[key]] : [null, key]);
      else if (isObject(this.state[collection])) records.push(key in this.state[collection] ? [collection, key, this.state[collection][key]] : [collection, key]);
      // A record inside a collection that was itself replaced or removed is covered by the top-level op.
    }
    const ops = [...top, ...records];
    const line = `${JSON.stringify({ o: ops })}\n`;
    fs.writeSync(this.fd, line); fs.fsyncSync(this.fd);
    this.pending.clear();
    const bytes = Buffer.byteLength(line);
    this.journalBytes += bytes; this.journalLines++; this.stats.commits++; this.stats.journalBytesWritten += bytes;
    if (this.verify) this.checkShadow(ops);
    if (this.journalBytes > Math.max(this.compactBytes, this.stats.snapshotBytes / 2) || this.journalLines > this.compactLines) this.snapshot();
  }
  checkShadow(ops) {
    applyOps(this.shadow, JSON.parse(JSON.stringify(ops)));
    const live = JSON.stringify(this.state), replayed = JSON.stringify(this.shadow);
    if (live === replayed) return;
    let where = '';
    for (const key of new Set([...Object.keys(this.state), ...Object.keys(this.shadow)])) {
      if (JSON.stringify(this.state[key]) === JSON.stringify(this.shadow[key])) continue;
      where = key;
      if (isObject(this.state[key]) && isObject(this.shadow[key])) {
        for (const k of new Set([...Object.keys(this.state[key]), ...Object.keys(this.shadow[key])])) {
          if (JSON.stringify(this.state[key][k]) !== JSON.stringify(this.shadow[key][k])) { where = `${key}.${k}`; break; }
        }
      }
      break;
    }
    this.shadow = JSON.parse(live);
    throw new Error(`DurableStore: write outside update tracking at state.${where}`);
  }
  /** Rewrite the snapshot from memory and start an empty journal. */
  snapshot() {
    const text = JSON.stringify(this.state);
    atomicWriteText(this.file, text);
    // The snapshot now holds everything; an older journal replayed on top of it is harmless (whole-record ops).
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    atomicWriteText(this.journal, '');
    if (!this.closing) this.fd = fs.openSync(this.journal, 'a', 0o600);
    this.pending.clear(); this.journalBytes = 0; this.journalLines = 0;
    this.stats.snapshots++; this.stats.snapshotBytes = Buffer.byteLength(text);
    if (this.verify) this.shadow = JSON.parse(text);
  }
  close() {
    this.closing = true;
    try {
      if (this.fd !== undefined) { this.flush(); this.snapshot(); }
    } finally {
      if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = null; }
      if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
      if (this.locked && readState(this.lockFile, null)?.token === this.lockToken) fs.unlinkSync(this.lockFile);
      this.locked = false;
    }
  }
}

/**
 * Write tracking for one update. Proxies are handed out lazily; a write marks
 * the record it belongs to and clones that record's previous value once.
 */
class Transaction {
  constructor(state) {
    this.state = state;
    this.dirty = new Map();   // key -> [collection|null, key]
    this.undo = [];           // [collection|null, key, existed, previous]
    this.raw = new WeakMap(); // proxy -> target
    this.cache = new Map();   // record key -> WeakMap(target -> proxy)
    this.root = this.wrapRoot();
  }
  mark(collection, key) {
    const id = collection === null ? `${SEP}${key}` : `${collection}${SEP}${key}`;
    if (this.dirty.has(id)) return;
    this.dirty.set(id, [collection, key]);
    const holder = collection === null ? this.state : this.state[collection];
    const existed = isObject(holder) && Object.prototype.hasOwnProperty.call(holder, key);
    this.undo.push([collection, key, existed, existed ? structuredClone(holder[key]) : undefined]);
  }
  rollback() {
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const [collection, key, existed, previous] = this.undo[i];
      const holder = collection === null ? this.state : this.state[collection];
      if (!isObject(holder)) continue;
      if (existed) holder[key] = previous; else delete holder[key];
    }
  }
  unwrap(value) {
    if (!isObject(value)) return value;
    const target = this.raw.get(value);
    if (target) return target;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = this.unwrap(value[i]); return value; }
    if (Object.getPrototypeOf(value) === Object.prototype) for (const k of Object.keys(value)) value[k] = this.unwrap(value[k]);
    return value;
  }
  proxyFor(target, recordKey, handler) {
    let map = this.cache.get(recordKey);
    if (!map) this.cache.set(recordKey, map = new WeakMap());
    let proxy = map.get(target);
    if (!proxy) { proxy = new Proxy(target, handler); map.set(target, proxy); this.raw.set(proxy, target); }
    return proxy;
  }
  wrapRecord(target, collection, key) {
    const txn = this, recordKey = `${collection}${SEP}${key}`;
    return this.proxyFor(target, recordKey, {
      get(t, p, r) { const v = Reflect.get(t, p, r); return isObject(v) && typeof p !== 'symbol' ? txn.wrapRecord(v, collection, key) : v; },
      set(t, p, v) { txn.mark(collection, key); t[p] = txn.unwrap(v); return true; },
      deleteProperty(t, p) { txn.mark(collection, key); delete t[p]; return true; },
      defineProperty(t, p, d) { txn.mark(collection, key); return Reflect.defineProperty(t, p, d); },
    });
  }
  wrapCollection(target, collection) {
    const txn = this;
    return this.proxyFor(target, `${SEP}${collection}`, {
      get(t, p, r) { const v = Reflect.get(t, p, r); return isObject(v) && typeof p !== 'symbol' ? txn.wrapRecord(v, collection, p) : v; },
      set(t, p, v) { txn.mark(collection, p); t[p] = txn.unwrap(v); return true; },
      deleteProperty(t, p) { txn.mark(collection, p); delete t[p]; return true; },
      defineProperty(t, p, d) { txn.mark(collection, p); return Reflect.defineProperty(t, p, d); },
    });
  }
  wrapRoot() {
    const txn = this;
    return new Proxy(this.state, {
      get(t, p, r) { const v = Reflect.get(t, p, r); return isObject(v) && typeof p !== 'symbol' ? txn.wrapCollection(v, p) : v; },
      set(t, p, v) { txn.mark(null, p); t[p] = txn.unwrap(v); return true; },
      deleteProperty(t, p) { txn.mark(null, p); delete t[p]; return true; },
      defineProperty(t, p, d) { txn.mark(null, p); return Reflect.defineProperty(t, p, d); },
    });
  }
}
