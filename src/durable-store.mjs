import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const identityOf = msg => JSON.stringify([msg.accountId, msg.fromUserId, msg.groupId || 'private']);
export function readState(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // File fsync plus directory fsync gives the queue an actual durable boundary.
  let parent;
  try { parent = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(parent); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM'].includes(error.code)) throw error; }
  finally { if (parent !== undefined) fs.closeSync(parent); }
}
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
  const directory = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export class DurableStore {
  constructor(root, { lock = true } = {}) {
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
    try {
      this.state = readState(this.file, { version: 1, nextTask: 1, inbox: {}, executions: {}, tasks: {}, contacts: {}, conversations: {}, outbox: {}, pendingMedia: {}, projects: {}, selectedProjects: {} });
      if (this.state.version !== 1) throw new Error('不支持的 IM 状态版本');
    } catch (error) { this.close(); throw error; }
  }
  acquire() { const fd = fs.openSync(this.lockFile, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  update(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    atomicWrite(this.file, next); this.state = next; return result;
  }
  close() {
    if (this.locked && readState(this.lockFile, null)?.token === this.lockToken) fs.unlinkSync(this.lockFile);
    this.locked = false;
  }
}
