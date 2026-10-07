// In-memory store for tests and local development.
//
// Use memoryStores() to get one store for each session key, like one
// Durable Object for each session in the Cloudflare adapter. One store can
// also hold the data of many sessions. It keeps the sessions apart: the
// pass limit and the activity log apply to each session key.
// The store loses all data when the process stops.
//
// Store interface:
//   async putPass({ referenceHash, sessionKey, expiresAt })
//   async getPass(referenceHash) -> { sessionKey, expiresAt } | null
//   async countUses(key, sinceMs) -> number of uses with atMs > sinceMs
//   async addUse(key, atMs)
//   async addUsesIfRoom(entries, atMs) -> counts (see budget.js)
//   async prune(nowMs)
//   async logActivity(event, { sessionKey })
//   async listActivity({ sessionKey, limit }) -> the events of that session, newest first

import { MAX_WINDOW_SECONDS } from './budget.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
// The activity log of events that come with no session key.
const NO_SESSION = Symbol('no session');

export class MemoryStore {
  #passes = new Map();
  #uses = new Map();
  // Session key -> events, oldest first.
  #activity = new Map();
  #keepActivity;
  #keepPasses;
  #keepUsesMs;

  // keepActivity: the number of newest events to keep for each session. The default is 200.
  // keepPasses: the number of passes to keep for each session. The store
  // keeps the passes that expire last. The default is 10.
  // keepUsesMs: prune removes uses older than this. Make it at least the
  // longest budget window. The default is 86400 seconds (1 day).
  constructor({ keepActivity = 200, keepPasses = 10, keepUsesMs = MAX_WINDOW_SECONDS * 1000 } = {}) {
    if (!Number.isSafeInteger(keepActivity) || keepActivity < 1) {
      throw new TypeError('agentlane: keepActivity must be a whole number, 1 or more.');
    }
    if (!Number.isSafeInteger(keepPasses) || keepPasses < 1) {
      throw new TypeError('agentlane: keepPasses must be a whole number, 1 or more.');
    }
    if (!Number.isSafeInteger(keepUsesMs) || keepUsesMs < 1000) {
      throw new TypeError('agentlane: keepUsesMs must be a whole number, 1000 or more.');
    }
    this.#keepActivity = keepActivity;
    this.#keepPasses = keepPasses;
    this.#keepUsesMs = keepUsesMs;
  }

  async putPass({ referenceHash, sessionKey, expiresAt } = {}) {
    if (typeof referenceHash !== 'string' || !HASH_PATTERN.test(referenceHash)) {
      throw new TypeError('agentlane: referenceHash must be 64 lower-case hex characters.');
    }
    if (typeof sessionKey !== 'string' || sessionKey === '') {
      throw new TypeError('agentlane: sessionKey must be a string that is not empty.');
    }
    if (!Number.isFinite(expiresAt)) throw new TypeError('agentlane: expiresAt must be a number of milliseconds.');
    this.#passes.set(referenceHash, { sessionKey, expiresAt });
    // Count only the passes of this session. Thus 1 session cannot remove
    // the passes of another session.
    const own = [...this.#passes].filter(([, pass]) => pass.sessionKey === sessionKey);
    if (own.length > this.#keepPasses) {
      // Remove the passes that expire first.
      own.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [hash] of own.slice(0, own.length - this.#keepPasses)) this.#passes.delete(hash);
    }
  }

  // The store does not check the time. The caller compares expiresAt with the current time.
  async getPass(referenceHash) {
    const pass = this.#passes.get(referenceHash);
    return pass ? { ...pass } : null;
  }

  async countUses(key, sinceMs) {
    return this.#count(key, sinceMs);
  }

  async addUse(key, atMs) {
    checkUse(key, atMs);
    this.#add(key, atMs);
  }

  // Count and add in 1 step. The method has no "await" before the add, so
  // no other call can run between the count and the add.
  async addUsesIfRoom(entries, atMs) {
    if (!Array.isArray(entries)) throw new TypeError('agentlane: entries must be a list.');
    for (const entry of entries) {
      checkUse(entry?.key, atMs);
      if (!Number.isFinite(entry.sinceMs)) throw new TypeError('agentlane: sinceMs must be a number of milliseconds.');
      if (!Number.isSafeInteger(entry.limit) || entry.limit < 1) {
        throw new TypeError('agentlane: limit must be a whole number, 1 or more.');
      }
    }
    const counts = entries.map((entry) => this.#count(entry.key, entry.sinceMs));
    if (entries.every((entry, index) => counts[index] < entry.limit)) {
      for (const entry of entries) this.#add(entry.key, atMs);
    }
    return counts;
  }

  #count(key, sinceMs) {
    const list = this.#uses.get(key);
    if (!list) return 0;
    let count = 0;
    for (const atMs of list) if (atMs > sinceMs) count += 1;
    return count;
  }

  #add(key, atMs) {
    const list = this.#uses.get(key);
    if (list) list.push(atMs);
    else this.#uses.set(key, [atMs]);
  }

  // Remove expired passes and old uses.
  async prune(nowMs = Date.now()) {
    for (const [hash, pass] of this.#passes) if (pass.expiresAt <= nowMs) this.#passes.delete(hash);
    const oldest = nowMs - this.#keepUsesMs;
    for (const [key, list] of this.#uses) {
      const kept = list.filter((atMs) => atMs > oldest);
      if (kept.length === 0) this.#uses.delete(key);
      else this.#uses.set(key, kept);
    }
  }

  // Add 1 event to the activity log of the session.
  async logActivity(event, { sessionKey } = {}) {
    if (!event || typeof event !== 'object') throw new TypeError('agentlane: the activity event must be an object.');
    const owner = activityOwner(sessionKey);
    const list = this.#activity.get(owner) ?? [];
    list.push({ ...event });
    if (list.length > this.#keepActivity) list.splice(0, list.length - this.#keepActivity);
    this.#activity.set(owner, list);
  }

  // Return the events of the session, newest first.
  async listActivity({ sessionKey, limit = 50 } = {}) {
    const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, this.#keepActivity) : 50;
    const list = this.#activity.get(activityOwner(sessionKey)) ?? [];
    return list
      .slice(-count)
      .reverse()
      .map((event) => ({ ...event }));
  }
}

// The key of the activity log of a session.
function activityOwner(sessionKey) {
  return typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : NO_SESSION;
}

function checkUse(key, atMs) {
  if (typeof key !== 'string' || key === '') throw new TypeError('agentlane: the use key must be a string.');
  if (!Number.isFinite(atMs)) throw new TypeError('agentlane: atMs must be a number of milliseconds.');
}

// Return a new MemoryStore.
export function createMemoryStore(options) {
  return new MemoryStore(options);
}

// Return a function (env, sessionKey) => store that gives 1 MemoryStore for
// each session key. It has the same shape as the `store` option of the
// Cloudflare adapter.
export function memoryStores(options) {
  const stores = new Map();
  return (_env, sessionKey) => {
    let store = stores.get(sessionKey);
    if (!store) {
      store = new MemoryStore(options);
      stores.set(sessionKey, store);
    }
    return store;
  };
}
