// Tests for the Durable Object store (src/cloudflare/store.js).
//
// Node.js has no "cloudflare:workers" module. A module hook gives the test a
// small DurableObject base class. node:sqlite gives a SQL interface like
// ctx.storage.sql in a Durable Object. If node:sqlite is not available,
// the tests are skipped.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const BASE_CLASS = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const HOOK = `export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(BASE_CLASS)}`)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`);

// node:sqlite is experimental in Node.js 22. Hide only its warning.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const { AgentLaneStore, KEEP_ACTIVITY, KEEP_PASSES, KEEP_USES_MS } = await import('../src/cloudflare/store.js');
const { withAgentLane } = await import('../src/cloudflare/worker.js');
const { hashReference } = await import('../src/core/index.js');

const skip = DatabaseSync ? false : 'node:sqlite is not available';
const T0 = 1_800_000_000_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// A SQL interface like ctx.storage.sql, over node:sqlite.
function sqlOver(db) {
  return {
    exec(query, ...bindings) {
      const statements = query.split(';').filter((part) => part.trim() !== '');
      let rows = [];
      if (statements.length > 1) {
        assert.equal(bindings.length, 0, 'a query with more than 1 statement has no bindings');
        db.exec(query);
      } else {
        rows = db.prepare(query).all(...bindings);
      }
      return { toArray: () => rows };
    },
  };
}

function newStore(db = new DatabaseSync(':memory:')) {
  const store = new AgentLaneStore({ storage: { sql: sqlOver(db) } }, {});
  return { store, db };
}

describe('AgentLaneStore', { skip }, () => {
  test('makes the tables, and can start again on the same database', () => {
    const { db } = newStore();
    newStore(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ['activity', 'passes', 'uses']);
  });

  test('puts and gets a pass', async () => {
    const { store } = newStore();
    await store.putPass({ referenceHash: HASH_A, sessionKey: 'session-1', expiresAt: T0 + 900_000 });
    assert.deepEqual(await store.getPass(HASH_A), { sessionKey: 'session-1', expiresAt: T0 + 900_000 });
    assert.equal(await store.getPass(HASH_B), null);
    assert.equal(await store.getPass(undefined), null);
  });

  test('accepts only a 64-character hex hash as the pass key', async () => {
    const { store } = newStore();
    const reference = 'c'.repeat(63);
    await assert.rejects(store.putPass({ referenceHash: reference, sessionKey: 's', expiresAt: T0 }), TypeError);
    await assert.rejects(store.putPass({ referenceHash: HASH_A, sessionKey: '', expiresAt: T0 }), TypeError);
    await assert.rejects(store.putPass({ referenceHash: HASH_A, sessionKey: 's', expiresAt: 'soon' }), TypeError);
  });

  test('addUsesIfRoom counts and adds in 1 step', async () => {
    const { store } = newStore();
    await store.addUse('budget:b', T0);
    const entries = [
      { key: 'budget:a', sinceMs: T0 - 1, limit: 1 },
      { key: 'budget:b', sinceMs: T0 - 1, limit: 2 },
    ];
    assert.deepEqual(await store.addUsesIfRoom(entries, T0 + 1), [0, 1]);
    assert.equal(await store.countUses('budget:a', T0 - 1), 1);
    assert.equal(await store.countUses('budget:b', T0 - 1), 2);
    // "budget:a" has no room now, so the store adds nothing.
    assert.deepEqual(await store.addUsesIfRoom(entries, T0 + 2), [1, 2]);
    assert.equal(await store.countUses('budget:b', T0 - 1), 2);
    // Calls at the same time cannot both use the last room.
    const results = await Promise.all(
      [1, 2, 3].map(() => store.addUsesIfRoom([{ key: 'budget:c', sinceMs: T0 - 1, limit: 1 }], T0 + 3)),
    );
    assert.deepEqual(results, [[0], [1], [1]]);
    assert.equal(await store.countUses('budget:c', T0 - 1), 1);
    await assert.rejects(store.addUsesIfRoom([{ key: 'k', sinceMs: T0, limit: 0 }], T0), TypeError);
  });

  test(`keeps the ${KEEP_PASSES} passes that expire last`, async () => {
    const { store, db } = newStore();
    for (let i = 0; i < KEEP_PASSES + 5; i += 1) {
      const hash = i.toString(16).padStart(64, '0');
      await store.putPass({ referenceHash: hash, sessionKey: 's', expiresAt: T0 + i });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passes').get().n, KEEP_PASSES);
    assert.equal(await store.getPass('0'.repeat(64)), null);
    assert.notEqual(await store.getPass((KEEP_PASSES + 4).toString(16).padStart(64, '0')), null);
  });

  test('counts uses after sinceMs, not at sinceMs', async () => {
    const { store } = newStore();
    await store.addUse('budget:a', T0);
    await store.addUse('budget:a', T0 + 1);
    await store.addUse('budget:b', T0 + 1);
    assert.equal(await store.countUses('budget:a', T0 - 1), 2);
    assert.equal(await store.countUses('budget:a', T0), 1);
    assert.equal(await store.countUses('budget:c', 0), 0);
  });

  test('prune deletes expired passes and uses older than 1 day', async () => {
    const { store } = newStore();
    await store.putPass({ referenceHash: HASH_A, sessionKey: 's', expiresAt: T0 });
    await store.putPass({ referenceHash: HASH_B, sessionKey: 's', expiresAt: T0 + 1 });
    await store.addUse('k', T0 - KEEP_USES_MS);
    await store.addUse('k', T0 - KEEP_USES_MS + 1);
    await store.prune(T0);
    assert.equal(await store.getPass(HASH_A), null);
    assert.notEqual(await store.getPass(HASH_B), null);
    assert.equal(await store.countUses('k', 0), 1);
    assert.equal(KEEP_USES_MS, 86_400_000);
  });

  test('keeps only the event fields in the activity log', async () => {
    const { store, db } = newStore();
    const reference = 'd'.repeat(64);
    await store.logActivity({
      at: T0,
      lane: 'agent',
      action: 'GET /api/items',
      status: 200,
      code: null,
      pass: reference,
      sessionKey: 'session-secret',
      reference,
    });
    const row = db.prepare('SELECT * FROM activity').get();
    assert.deepEqual(Object.keys(row).sort(), ['action', 'at', 'code', 'id', 'lane', 'pass', 'session_hash', 'status']);
    assert.equal(row.pass, 'dddddddd', 'never more than 8 characters of the reference');
    assert.equal(row.session_hash, null, 'the event field sessionKey is not copied');
    assert.deepEqual(await store.listActivity(), [
      { at: T0, lane: 'agent', action: 'GET /api/items', status: 200, code: null, pass: 'dddddddd' },
    ]);
  });

  test('1 object for many sessions keeps the sessions apart', async () => {
    const { store, db } = newStore();
    await store.putPass({ referenceHash: HASH_A, sessionKey: 'alice', expiresAt: T0 });
    // Bob gets many passes that expire later. They do not remove the pass of Alice.
    for (let i = 0; i < KEEP_PASSES + 5; i += 1) {
      const hash = (i + 1000).toString(16).padStart(64, '0');
      await store.putPass({ referenceHash: hash, sessionKey: 'bob', expiresAt: T0 + 1000 + i });
    }
    assert.deepEqual(await store.getPass(HASH_A), { sessionKey: 'alice', expiresAt: T0 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE session_key = 'bob'").get().n, KEEP_PASSES);

    const event = (at) => ({ at, lane: 'agent', action: 'GET /x', status: 200, code: null, pass: null });
    await store.logActivity(event(T0), { sessionKey: 'alice' });
    for (let i = 1; i <= KEEP_ACTIVITY + 5; i += 1) await store.logActivity(event(T0 + i), { sessionKey: 'bob' });
    assert.deepEqual((await store.listActivity({ sessionKey: 'alice' })).map((e) => e.at), [T0]);
    assert.equal((await store.listActivity({ sessionKey: 'bob', limit: 1000 })).length, KEEP_ACTIVITY);
    assert.deepEqual(await store.listActivity({ sessionKey: 'carol' }), []);
    const dump = JSON.stringify(db.prepare('SELECT * FROM activity').all());
    assert.ok(!dump.includes('alice') && !dump.includes('bob'), 'the table keeps a hash of the session key');
  });

  test('adds the session_hash column to an activity table from an older version', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT NOT NULL, ' +
        'action TEXT, status INTEGER, code TEXT, pass TEXT)',
    );
    const { store } = newStore(db);
    newStore(db);
    await store.logActivity({ at: T0, lane: 'agent', action: 'GET /x', status: 200 }, { sessionKey: 'alice' });
    assert.equal((await store.listActivity({ sessionKey: 'alice' })).length, 1);
  });

  test(`keeps the ${KEEP_ACTIVITY} newest events and lists the newest first`, async () => {
    const { store, db } = newStore();
    for (let i = 0; i < KEEP_ACTIVITY + 10; i += 1) {
      await store.logActivity({ at: T0 + i, lane: 'agent', action: 'GET /x', status: 200, code: null, pass: null });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, KEEP_ACTIVITY);
    const latest = await store.listActivity();
    assert.equal(latest.length, 50);
    assert.equal(latest[0].at, T0 + KEEP_ACTIVITY + 9);
    assert.equal(latest[1].at, T0 + KEEP_ACTIVITY + 8);
    assert.equal((await store.listActivity({ limit: 3 })).length, 3);
    assert.equal((await store.listActivity({ limit: 1000 })).length, KEEP_ACTIVITY);
    assert.equal((await store.listActivity({ limit: -1 })).length, 50);
    const oldest = (await store.listActivity({ limit: KEEP_ACTIVITY })).at(-1);
    assert.equal(oldest.at, T0 + 10);
  });
});

test('src/cloudflare/index.js exports the adapter, the store and the WAF rules', async () => {
  const adapter = await import('../src/cloudflare/index.js');
  assert.equal(typeof adapter.withAgentLane, 'function');
  assert.equal(adapter.AgentLaneStore, AgentLaneStore);
  assert.equal(typeof adapter.wafRules, 'function');
  assert.equal(typeof adapter.orderedRules, 'function');
});

describe('withAgentLane over AgentLaneStore', { skip }, () => {
  test('runs the full flow with SQLite storage', async () => {
    const secret = 'test-secret-0123456789abcdef0123456789abcdef';
    const origin = 'https://shop.example';
    const objects = new Map();
    const clock = { ms: T0 };
    const calls = [];
    const lane = withAgentLane(
      async (request) => {
        calls.push(request.url);
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
      },
      {
        secret: (env) => env.AGENTLANE_SECRET,
        session: async (request) => (request.headers.get('Cookie') === 'sid=1' ? 'session-1' : null),
        scope: ['GET /api/items'],
        budgets: [{ name: 'reads', actions: '*', limit: 2, windowSeconds: 60, per: 'session' }],
        store: (_env, sessionKey) => {
          if (!objects.has(sessionKey)) objects.set(sessionKey, newStore());
          return objects.get(sessionKey).store;
        },
        onAgentRequest: () => {},
        now: () => clock.ms,
      },
    );
    const env = { AGENTLANE_SECRET: secret };
    const call = (path, init) => lane.fetch(new Request(origin + path, init), env, undefined);

    const passResponse = await call('/agentlane/pass', { method: 'POST', headers: { Origin: origin, Cookie: 'sid=1' } });
    assert.equal(passResponse.status, 201);
    const pass = await passResponse.json();

    const { db } = objects.get('session-1');
    const stored = db.prepare('SELECT reference_hash FROM passes').all();
    assert.deepEqual(stored.map((row) => row.reference_hash), [await hashReference(pass.reference)]);

    const headers = { Cookie: 'sid=1', 'X-Agent-Session': pass.reference, 'X-Agent-Proof': pass.proofs['GET /api/items'] };
    assert.equal((await call('/api/items', { headers })).status, 200);
    const second = await call('/api/items', { headers });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('RateLimit'), '"reads";r=0;t=60');
    const third = await call('/api/items', { headers });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('Retry-After'), '60');
    assert.equal(calls.length, 2);

    const activity = await call('/agentlane/activity', { headers: { Cookie: 'sid=1' } });
    const { events } = await activity.json();
    assert.deepEqual(
      events.map((event) => event.status),
      [429, 200, 200, 201],
    );
    const dump = JSON.stringify(db.prepare('SELECT * FROM activity').all());
    assert.ok(!dump.includes(pass.reference));
    assert.ok(!dump.includes('session-1'));
  });
});
