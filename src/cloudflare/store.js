// Durable Object store for the agent lane.
//
// The Worker adapter uses one AgentLaneStore for each signed-in session
// (idFromName(sessionKey)). The Worker calls the methods below with Durable
// Object RPC. Each object keeps its data in SQLite:
//
//   passes    the hash of each pass reference, its session and its expiry
//   uses      one row for each counted tool request (for budgets)
//   activity  the activity log; the store keeps the 200 newest events
//
// The store also keeps the sessions apart if 1 object holds many sessions:
// the pass limit and the activity log apply to each session key.
// The store never keeps the full reference. It keeps only its hash.
// The activity table keeps a hash of the session key, not the key.
//
// Wrangler configuration (the class needs SQLite storage):
//
//   [[durable_objects.bindings]]
//   name = "AGENTLANE"
//   class_name = "AgentLaneStore"
//
//   [[migrations]]
//   tag = "agentlane-v1"
//   new_sqlite_classes = ["AgentLaneStore"]
//
// Durable Object RPC needs compatibility_date "2024-04-03" or later.

import { DurableObject } from 'cloudflare:workers';
import { MAX_WINDOW_SECONDS, sha256Hex } from '../core/index.js';

/** The store keeps this many activity events for each session. It deletes older events. */
export const KEEP_ACTIVITY = 200;
/** The store keeps this many passes for each session. It deletes the passes that expire first. */
export const KEEP_PASSES = 10;
/** prune() keeps uses for the longest budget window that core permits (1 day). */
export const KEEP_USES_MS = MAX_WINDOW_SECONDS * 1000;
/** listActivity() returns this many events if the caller gives no limit. */
export const DEFAULT_ACTIVITY_LIMIT = 50;

const HASH_PATTERN = /^[a-f0-9]{64}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS passes (
  reference_hash TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uses_key_at ON uses (key, at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  lane TEXT NOT NULL,
  action TEXT,
  status INTEGER,
  code TEXT,
  pass TEXT,
  session_hash TEXT
);
`;
const ACTIVITY_INDEX = 'CREATE INDEX IF NOT EXISTS activity_session ON activity (session_hash, id)';

/**
 * The store logic over a SQL interface. The interface is the same as
 * ctx.storage.sql in a Durable Object: exec(query, ...bindings) returns
 * a cursor with toArray(). The tests use this class with node:sqlite.
 */
export class SqlAgentLaneStore {
  /** @param {{exec: (query: string, ...bindings: unknown[]) => {toArray: () => object[]}}} sql */
  constructor(sql) {
    this.sql = sql;
    this.sql.exec(SCHEMA);
    // An activity table from an older version has no session_hash column. Add it.
    const columns = this.rows('PRAGMA table_info(activity)').map((row) => row.name);
    if (!columns.includes('session_hash')) this.sql.exec('ALTER TABLE activity ADD COLUMN session_hash TEXT');
    this.sql.exec(ACTIVITY_INDEX);
  }

  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  async putPass({ referenceHash, sessionKey, expiresAt } = {}) {
    if (typeof referenceHash !== 'string' || !HASH_PATTERN.test(referenceHash)) {
      throw new TypeError('agentlane: "referenceHash" must be 64 lower-case hex characters.');
    }
    requireText('sessionKey', sessionKey);
    requireTime('expiresAt', expiresAt);
    this.sql.exec(
      'INSERT OR REPLACE INTO passes (reference_hash, session_key, expires_at) VALUES (?, ?, ?)',
      referenceHash,
      sessionKey,
      expiresAt,
    );
    // Count only the passes of this session. Thus 1 session cannot remove
    // the passes of another session.
    this.sql.exec(
      'DELETE FROM passes WHERE session_key = ? AND reference_hash NOT IN ' +
        '(SELECT reference_hash FROM passes WHERE session_key = ? ORDER BY expires_at DESC LIMIT ?)',
      sessionKey,
      sessionKey,
      KEEP_PASSES,
    );
  }

  // The store does not check the time. The caller compares expiresAt with the current time.
  async getPass(referenceHash) {
    if (typeof referenceHash !== 'string') return null;
    const row = this.rows(
      'SELECT session_key, expires_at FROM passes WHERE reference_hash = ?',
      referenceHash,
    )[0];
    return row ? { sessionKey: row.session_key, expiresAt: Number(row.expires_at) } : null;
  }

  /** Count the uses of a key that happened after sinceMs. */
  async countUses(key, sinceMs) {
    requireText('key', key);
    requireTime('sinceMs', sinceMs);
    const row = this.rows('SELECT COUNT(*) AS n FROM uses WHERE key = ? AND at > ?', key, sinceMs)[0];
    return Number(row?.n ?? 0);
  }

  async addUse(key, atMs) {
    requireText('key', key);
    requireTime('atMs', atMs);
    this.sql.exec('INSERT INTO uses (key, at) VALUES (?, ?)', key, atMs);
  }

  /**
   * Count the uses of each key, and add 1 use to each key if all counts are
   * less than their limits. Returns the counts from before the add.
   * The SQL calls are synchronous and the method has no "await". Thus, in a
   * Durable Object, no other request can run between the count and the add.
   * @param {{key: string, sinceMs: number, limit: number}[]} entries
   * @param {number} atMs
   */
  async addUsesIfRoom(entries, atMs) {
    if (!Array.isArray(entries)) throw new TypeError('agentlane: "entries" must be a list.');
    requireTime('atMs', atMs);
    for (const entry of entries) {
      requireText('key', entry?.key);
      requireTime('sinceMs', entry.sinceMs);
      if (!Number.isSafeInteger(entry.limit) || entry.limit < 1) {
        throw new TypeError('agentlane: "limit" must be a whole number, 1 or more.');
      }
    }
    const counts = entries.map(({ key, sinceMs }) => {
      const row = this.rows('SELECT COUNT(*) AS n FROM uses WHERE key = ? AND at > ?', key, sinceMs)[0];
      return Number(row?.n ?? 0);
    });
    if (entries.every((entry, index) => counts[index] < entry.limit)) {
      for (const { key } of entries) this.sql.exec('INSERT INTO uses (key, at) VALUES (?, ?)', key, atMs);
    }
    return counts;
  }

  /** Delete expired passes, and uses that are older than the longest budget window. */
  async prune(nowMs = Date.now()) {
    requireTime('nowMs', nowMs);
    this.sql.exec('DELETE FROM passes WHERE expires_at <= ?', nowMs);
    this.sql.exec('DELETE FROM uses WHERE at <= ?', nowMs - KEEP_USES_MS);
  }

  /**
   * Add one event to the activity log of the session. The event comes from
   * activityEvent() in src/core/activity.js. The store keeps the 200 newest
   * events for each session.
   */
  async logActivity(event, { sessionKey } = {}) {
    if (!event || typeof event !== 'object') throw new TypeError('agentlane: the event must be an object.');
    requireTime('event.at', event.at);
    const owner = await sessionHash(sessionKey);
    // Copy only the event fields. Never copy a session key or a full reference.
    this.sql.exec(
      'INSERT INTO activity (at, lane, action, status, code, pass, session_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      event.at,
      typeof event.lane === 'string' ? event.lane : 'agent',
      typeof event.action === 'string' ? event.action : null,
      Number.isSafeInteger(event.status) ? event.status : null,
      typeof event.code === 'string' ? event.code : null,
      typeof event.pass === 'string' ? event.pass.slice(0, 8) : null,
      owner,
    );
    this.sql.exec(
      'DELETE FROM activity WHERE session_hash IS ? AND id NOT IN ' +
        '(SELECT id FROM activity WHERE session_hash IS ? ORDER BY id DESC LIMIT ?)',
      owner,
      owner,
      KEEP_ACTIVITY,
    );
  }

  /** Return the activity events of the session, newest first. */
  async listActivity({ sessionKey, limit = DEFAULT_ACTIVITY_LIMIT } = {}) {
    const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, KEEP_ACTIVITY) : DEFAULT_ACTIVITY_LIMIT;
    const owner = await sessionHash(sessionKey);
    const rows = this.rows(
      'SELECT at, lane, action, status, code, pass FROM activity WHERE session_hash IS ? ORDER BY id DESC LIMIT ?',
      owner,
      count,
    );
    return rows.map((row) => ({
      at: Number(row.at),
      lane: row.lane,
      action: row.action ?? null,
      status: row.status == null ? null : Number(row.status),
      code: row.code ?? null,
      pass: row.pass ?? null,
    }));
  }
}

/**
 * The Durable Object class. Export it from the Worker entry module and bind
 * it as AGENTLANE. The Worker adapter calls its methods with RPC.
 */
export class AgentLaneStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new SqlAgentLaneStore(ctx.storage.sql);
  }

  putPass(pass) {
    return this.store.putPass(pass);
  }

  getPass(referenceHash) {
    return this.store.getPass(referenceHash);
  }

  countUses(key, sinceMs) {
    return this.store.countUses(key, sinceMs);
  }

  addUse(key, atMs) {
    return this.store.addUse(key, atMs);
  }

  addUsesIfRoom(entries, atMs) {
    return this.store.addUsesIfRoom(entries, atMs);
  }

  prune(nowMs) {
    return this.store.prune(nowMs);
  }

  logActivity(event, options) {
    return this.store.logActivity(event, options);
  }

  listActivity(options) {
    return this.store.listActivity(options);
  }
}

// Return the hash of the session key, or null if there is no session key.
async function sessionHash(sessionKey) {
  if (sessionKey === undefined || sessionKey === null) return null;
  requireText('sessionKey', sessionKey);
  return sha256Hex(sessionKey);
}

function requireText(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError(`agentlane: "${name}" must be a string with 1 to 512 characters.`);
  }
}

function requireTime(name, value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`agentlane: "${name}" must be a number of milliseconds.`);
  }
}
