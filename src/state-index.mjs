/**
 * In-memory indexes over the durable state, so the 1-second loops touch only
 * open work instead of scanning every record kept for the retention window.
 * Built once at startup and kept current from DurableStore change events
 * (every committed record write reports its collection, key and new value).
 */
const ACTIVE = new Set(['queued', 'running']);
const REF_LIMIT = 300;

function toggle(set, key, on) { if (on) set.add(key); else set.delete(key); }

export class StateIndex {
  constructor() {
    this.openInbox = new Set();      // inbox ids queued or processing, arrival order
    this.activeExec = new Set();     // execution ids queued or running, creation order
    this.unknownExec = new Set();    // execution ids whose outcome is unknown (fence their workspace)
    this.pendingOutbox = new Set();  // outbox ids waiting to be sent, creation order
    this.refOutbox = new Map();      // owner -> outbox ids that carry a ref (newest last), for quote matching
  }
  rebuild(state, collection) {
    const all = !collection;
    if (all || collection === 'inbox') { this.openInbox.clear(); for (const [k, v] of Object.entries(state.inbox || {})) this.apply('inbox', k, v); }
    if (all || collection === 'executions') { this.activeExec.clear(); this.unknownExec.clear(); for (const [k, v] of Object.entries(state.executions || {})) this.apply('executions', k, v); }
    if (all || collection === 'outbox') { this.pendingOutbox.clear(); this.refOutbox.clear(); for (const [k, v] of Object.entries(state.outbox || {})) this.apply('outbox', k, v); }
  }
  /** DurableStore change listener. `state` is passed for whole-collection replacements. */
  apply(collection, key, value, state) {
    if (collection === null) { if (['inbox', 'executions', 'outbox'].includes(key) && state) this.rebuild(state, key); return; }
    if (collection === 'inbox') toggle(this.openInbox, key, value && (value.status === 'queued' || value.status === 'processing'));
    else if (collection === 'executions') {
      toggle(this.activeExec, key, value && ACTIVE.has(value.status));
      toggle(this.unknownExec, key, value?.status === 'unknown');
    } else if (collection === 'outbox') {
      toggle(this.pendingOutbox, key, value?.status === 'pending');
      if (value?.ref && value.owner) {
        const list = this.refOutbox.get(value.owner) || [];
        if (!list.includes(key)) { list.push(key); if (list.length > REF_LIMIT) list.splice(0, list.length - REF_LIMIT); this.refOutbox.set(value.owner, list); }
      }
    }
  }
}
