import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRecordUse, checkBudgets, rateLimitHeaders, recordUse, validateBudgets } from '../src/core/budget.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { newReference } from '../src/core/pass.js';

// A time at the start of an hour, so that windows of 30, 60 and 3600 seconds start here.
const HOUR = 3_600_000;
const BASE = Math.floor(1_790_000_000_000 / HOUR) * HOUR;
const SESSION = 'session-key-of-person-a';
const BOOK = ['POST', '/api/reservations'];
const READ = ['GET', '/api/restaurants'];

// Do what the adapter does: check, and count the request only if the check passes.
async function attempt(store, budgets, [method, path], reference, nowMs, sessionKey = SESSION) {
  const input = { budgets, method, path, reference, sessionKey, nowMs };
  const result = await checkBudgets(store, input);
  if (result.ok) await recordUse(store, input);
  return result;
}

// A store that records every call.
function spyStore() {
  const inner = new MemoryStore();
  const calls = [];
  return {
    calls,
    countUses: async (key, sinceMs) => {
      calls.push(['countUses', key, sinceMs]);
      return inner.countUses(key, sinceMs);
    },
    addUse: async (key, atMs) => {
      calls.push(['addUse', key, atMs]);
      return inner.addUse(key, atMs);
    },
  };
}

test('validateBudgets returns copies in normal form', () => {
  const input = [
    { name: 'bookings', actions: ['post /api/reservations'], limit: 1, windowSeconds: 86400, per: 'pass' },
    { name: 'all.tools_1', actions: '*', limit: 30, windowSeconds: 60 },
  ];
  const output = validateBudgets(input);
  assert.deepEqual(output, [
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 86400, per: 'pass' },
    { name: 'all.tools_1', actions: '*', limit: 30, windowSeconds: 60, per: 'session' },
  ]);
  assert.notEqual(output[0], input[0]);
  assert.deepEqual(validateBudgets(undefined), []);
  assert.deepEqual(validateBudgets([]), []);
});

test('validateBudgets throws TypeError for a budget that is not valid', () => {
  const good = { name: 'reads', actions: '*', limit: 5, windowSeconds: 30, per: 'session' };
  const bad = [
    { ...good, name: '' },
    { ...good, name: 'has space' },
    { ...good, name: 'quote"name' },
    { ...good, name: 'x'.repeat(65) },
    { ...good, actions: [] },
    { ...good, actions: 'GET /api/x' },
    { ...good, actions: ['GET /api/x?y=1'] },
    { ...good, limit: 0 },
    { ...good, limit: 1.5 },
    { ...good, limit: '5' },
    { ...good, windowSeconds: 0 },
    { ...good, windowSeconds: 86401 },
    { ...good, windowSeconds: 0.5 },
    { ...good, per: 'user' },
  ];
  for (const budget of bad) assert.throws(() => validateBudgets([budget]), TypeError, JSON.stringify(budget));
  assert.throws(() => validateBudgets([good, good]), /2 budgets have the name "[^"]+"\. Give each budget a different name\./);
  assert.throws(() => validateBudgets(good), TypeError);
  assert.throws(() => validateBudgets([null]), TypeError);
  assert.throws(
    () => validateBudgets([{ ...good, actions: ['GET /api/other'] }], ['GET /api/restaurants']),
    /not in the scope/,
  );
});

test('per "pass": each pass has its own count', async () => {
  const store = new MemoryStore();
  const budgets = [{ name: 'per-pass', actions: '*', limit: 2, windowSeconds: 60, per: 'pass' }];
  const a = newReference();
  const b = newReference();
  assert.equal((await attempt(store, budgets, READ, a, BASE + 1000)).ok, true);
  assert.equal((await attempt(store, budgets, READ, a, BASE + 2000)).ok, true);
  const blocked = await attempt(store, budgets, READ, a, BASE + 3000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'budget');
  assert.equal(blocked.budget, 'per-pass');
  // A new pass in the same session has a new count.
  assert.equal((await attempt(store, budgets, READ, b, BASE + 4000)).ok, true);
});

test('per "session": all passes of the session share 1 count', async () => {
  const store = new MemoryStore();
  const budgets = [{ name: 'per-session', actions: '*', limit: 2, windowSeconds: 60, per: 'session' }];
  assert.equal((await attempt(store, budgets, READ, newReference(), BASE + 1000)).ok, true);
  assert.equal((await attempt(store, budgets, READ, newReference(), BASE + 2000)).ok, true);
  const blocked = await attempt(store, budgets, READ, newReference(), BASE + 3000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.budget, 'per-session');
  // Another session has its own count, also in the same store.
  assert.equal((await attempt(store, budgets, READ, newReference(), BASE + 3000, 'session-key-of-person-b')).ok, true);
});

test('fixed windows: the count resets at the next window, and retryAfter is the exact wait', async () => {
  const store = new MemoryStore();
  const budgets = [{ name: 'reads', actions: '*', limit: 1, windowSeconds: 60, per: 'session' }];
  const reference = newReference();

  const first = await attempt(store, budgets, READ, reference, BASE + 15_000);
  assert.deepEqual(first, {
    ok: true,
    applied: [{ name: 'reads', limit: 1, windowSeconds: 60, remaining: 0, resetSeconds: 45 }],
  });

  const blocked = await attempt(store, budgets, READ, reference, BASE + 20_500);
  assert.deepEqual(blocked, {
    ok: false,
    code: 'budget',
    budget: 'reads',
    retryAfter: 40,
    applied: [{ name: 'reads', limit: 1, windowSeconds: 60, remaining: 0, resetSeconds: 40 }],
  });

  // 1 millisecond before the next window: still blocked, wait 1 second.
  const last = await attempt(store, budgets, READ, reference, BASE + 59_999);
  assert.equal(last.ok, false);
  assert.equal(last.retryAfter, 1);

  // At the start of the next window: room again.
  const next = await attempt(store, budgets, READ, reference, BASE + 60_000);
  assert.equal(next.ok, true);
  assert.deepEqual(next.applied[0], { name: 'reads', limit: 1, windowSeconds: 60, remaining: 0, resetSeconds: 60 });
});

test('"*" covers all actions; a list covers only its actions', async () => {
  const store = new MemoryStore();
  const budgets = [
    { name: 'all', actions: '*', limit: 10, windowSeconds: 60 },
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 3600 },
  ];
  const reference = newReference();
  const read = await attempt(store, budgets, READ, reference, BASE);
  assert.deepEqual(read.applied.map((item) => item.name), ['all']);
  const book = await attempt(store, budgets, BOOK, reference, BASE);
  assert.deepEqual(book.applied.map((item) => item.name).sort(), ['all', 'bookings']);
  // An action that no budget covers has no limit and no RateLimit headers.
  const free = await checkBudgets(store, {
    budgets: [budgets[1]],
    method: 'GET',
    path: '/api/restaurants',
    reference,
    sessionKey: SESSION,
    nowMs: BASE,
  });
  assert.deepEqual(free, { ok: true, applied: [] });
  assert.deepEqual(rateLimitHeaders(free.applied), {});
});

test('multiple budgets: the strictest budget wins and retryAfter is correct', async () => {
  const store = new MemoryStore();
  const budgets = [
    { name: 'burst', actions: '*', limit: 3, windowSeconds: 30, per: 'session' },
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 3600, per: 'session' },
  ];
  const reference = newReference();

  // 1 booking: both budgets apply. "bookings" has no room left, so it is first.
  const first = await attempt(store, budgets, BOOK, reference, BASE + 10_000);
  assert.equal(first.ok, true);
  assert.deepEqual(first.applied, [
    { name: 'bookings', limit: 1, windowSeconds: 3600, remaining: 0, resetSeconds: 3590 },
    { name: 'burst', limit: 3, windowSeconds: 30, remaining: 2, resetSeconds: 20 },
  ]);

  // A second booking: only "bookings" has no room. The wait is the "bookings" wait.
  const second = await attempt(store, budgets, BOOK, reference, BASE + 11_000);
  assert.equal(second.ok, false);
  assert.equal(second.budget, 'bookings');
  assert.equal(second.retryAfter, 3589);
  assert.deepEqual(second.applied, [
    { name: 'bookings', limit: 1, windowSeconds: 3600, remaining: 0, resetSeconds: 3589 },
    { name: 'burst', limit: 3, windowSeconds: 30, remaining: 2, resetSeconds: 19 },
  ]);

  // 2 reads use up "burst". A read is now blocked by "burst" only.
  assert.equal((await attempt(store, budgets, READ, reference, BASE + 12_000)).ok, true);
  assert.equal((await attempt(store, budgets, READ, reference, BASE + 13_000)).ok, true);
  const read = await attempt(store, budgets, READ, reference, BASE + 14_000);
  assert.equal(read.ok, false);
  assert.equal(read.budget, 'burst');
  assert.equal(read.retryAfter, 16);

  // A booking is now blocked by both budgets. The request needs room in both,
  // so retryAfter is the longest wait.
  const both = await attempt(store, budgets, BOOK, reference, BASE + 14_000);
  assert.equal(both.ok, false);
  assert.equal(both.budget, 'bookings');
  assert.equal(both.retryAfter, 3586);
  assert.deepEqual(both.applied.map((item) => [item.name, item.remaining]), [['bookings', 0], ['burst', 0]]);

  // In the next 30-second window, reads have room again; bookings do not.
  assert.equal((await attempt(store, budgets, READ, reference, BASE + 30_000)).ok, true);
  const later = await attempt(store, budgets, BOOK, reference, BASE + 30_000);
  assert.equal(later.ok, false);
  assert.equal(later.budget, 'bookings');
  assert.equal(later.retryAfter, 3570);
});

test('recordUse only on success: checkBudgets never writes, and blocked requests are not counted', async () => {
  const store = spyStore();
  const budgets = [{ name: 'reads', actions: '*', limit: 3, windowSeconds: 60 }];
  const reference = newReference();
  const input = { budgets, method: 'GET', path: '/api/restaurants', reference, sessionKey: SESSION, nowMs: BASE };

  for (let i = 0; i < 5; i += 1) await checkBudgets(store, input);
  assert.equal(store.calls.filter(([name]) => name === 'addUse').length, 0);

  const results = [];
  for (let i = 0; i < 6; i += 1) results.push((await attempt(store, budgets, READ, reference, BASE + i)).ok);
  assert.deepEqual(results, [true, true, true, false, false, false]);
  assert.equal(store.calls.filter(([name]) => name === 'addUse').length, 3);
  const key = store.calls.find(([name]) => name === 'addUse')[1];
  assert.equal(await store.countUses(key, BASE - 1), 3);
});

test('remaining: the room after this request', async () => {
  const store = new MemoryStore();
  const budgets = [{ name: 'reads', actions: '*', limit: 3, windowSeconds: 60 }];
  const reference = newReference();
  const remaining = [];
  for (let i = 0; i < 4; i += 1) remaining.push((await attempt(store, budgets, READ, reference, BASE)).applied[0].remaining);
  assert.deepEqual(remaining, [2, 1, 0, 0]);
});

test('recordUse counts 1 use in each budget that covers the action, and in no other budget', async () => {
  const store = spyStore();
  const budgets = [
    { name: 'all', actions: '*', limit: 10, windowSeconds: 60, per: 'session' },
    { name: 'per-pass', actions: '*', limit: 10, windowSeconds: 60, per: 'pass' },
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 3600 },
  ];
  await recordUse(store, { budgets, method: 'GET', path: '/api/restaurants', reference: newReference(), sessionKey: SESSION, nowMs: BASE });
  const keys = store.calls.filter(([name]) => name === 'addUse').map(([, key]) => key);
  assert.equal(keys.length, 2);
  assert.equal(keys.some((key) => key.startsWith('budget:all:session:')), true);
  assert.equal(keys.some((key) => key.startsWith('budget:per-pass:pass:')), true);
  assert.equal(keys.some((key) => key.includes('bookings')), false);
});

test('store keys hold hashes, never the reference or the session key', async () => {
  const store = spyStore();
  const reference = newReference();
  const budgets = [
    { name: 'a', actions: '*', limit: 5, windowSeconds: 60, per: 'pass' },
    { name: 'b', actions: '*', limit: 5, windowSeconds: 60, per: 'session' },
  ];
  await attempt(store, budgets, READ, reference, BASE);
  assert.ok(store.calls.length > 0);
  for (const [, key] of store.calls) {
    assert.equal(key.includes(reference), false);
    assert.equal(key.includes(SESSION), false);
    assert.match(key, /^budget:[ab]:(pass|session):[a-f0-9]{64}$/);
  }
});

test('a budget needs the reference (per "pass") or the session key (per "session")', async () => {
  const store = new MemoryStore();
  const perPass = [{ name: 'p', actions: '*', limit: 1, windowSeconds: 60, per: 'pass' }];
  const perSession = [{ name: 's', actions: '*', limit: 1, windowSeconds: 60, per: 'session' }];
  const input = { method: 'GET', path: '/api/x', nowMs: BASE };
  await assert.rejects(checkBudgets(store, { ...input, budgets: perPass, sessionKey: SESSION }), TypeError);
  await assert.rejects(checkBudgets(store, { ...input, budgets: perSession, reference: newReference() }), TypeError);
  await assert.rejects(recordUse(store, { ...input, budgets: perPass, sessionKey: SESSION }), TypeError);
  await assert.rejects(recordUse(store, { ...input, budgets: perSession, reference: newReference() }), TypeError);
  // Without budgets, nothing is needed.
  assert.deepEqual(await checkBudgets(store, { ...input, budgets: [] }), { ok: true, applied: [] });
});

test('rateLimitHeaders uses the IETF draft format, strictest budget first', () => {
  const headers = rateLimitHeaders([
    { name: 'burst', limit: 3, windowSeconds: 30, remaining: 2, resetSeconds: 20 },
    { name: 'bookings', limit: 1, windowSeconds: 3600, remaining: 0, resetSeconds: 3590 },
    { name: 'reads', limit: 20, windowSeconds: 30, remaining: 2, resetSeconds: 25 },
  ]);
  assert.deepEqual(headers, {
    'RateLimit-Policy': '"bookings";q=1;w=3600, "reads";q=20;w=30, "burst";q=3;w=30',
    RateLimit: '"bookings";r=0;t=3590, "reads";r=2;t=25, "burst";r=2;t=20',
  });
});

test('rateLimitHeaders: 1 budget, no budget, and names with special characters', () => {
  assert.deepEqual(rateLimitHeaders([{ name: 'reads', limit: 20, windowSeconds: 30, remaining: 19, resetSeconds: 12 }]), {
    'RateLimit-Policy': '"reads";q=20;w=30',
    RateLimit: '"reads";r=19;t=12',
  });
  assert.deepEqual(rateLimitHeaders([]), {});
  assert.deepEqual(rateLimitHeaders(undefined), {});
  const escaped = rateLimitHeaders([{ name: 'a"b\\c', limit: 1, remaining: 0, resetSeconds: 1 }]);
  assert.equal(escaped['RateLimit-Policy'], '"a\\"b\\\\c";q=1');
  assert.equal(escaped.RateLimit, '"a\\"b\\\\c";r=0;t=1');
});

test('rateLimitHeaders output can be used as HTTP headers', async () => {
  const store = new MemoryStore();
  const budgets = [
    { name: 'burst', actions: '*', limit: 3, windowSeconds: 30 },
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 3600 },
  ];
  const result = await attempt(store, budgets, BOOK, newReference(), BASE);
  const headers = new Headers(rateLimitHeaders(result.applied));
  assert.equal(headers.get('ratelimit-policy'), '"bookings";q=1;w=3600, "burst";q=3;w=30');
  assert.equal(headers.get('ratelimit'), '"bookings";r=0;t=3600, "burst";r=2;t=30');
});

test('checkAndRecordUse gives the same results as checkBudgets then recordUse', async () => {
  const budgets = [
    { name: 'writes', actions: ['POST /api/reservations'], limit: 2, windowSeconds: 60, per: 'session' },
    { name: 'all', actions: '*', limit: 3, windowSeconds: 30, per: 'pass' },
  ];
  const reference = newReference();
  const atomic = new MemoryStore();
  const twoStep = new MemoryStore();
  for (let i = 0; i < 5; i += 1) {
    const nowMs = BASE + i * 1000;
    const input = { budgets, method: BOOK[0], path: BOOK[1], reference, sessionKey: SESSION, nowMs };
    assert.deepEqual(await checkAndRecordUse(atomic, input), await attempt(twoStep, budgets, BOOK, reference, nowMs));
  }
  const input = { budgets, method: BOOK[0], path: BOOK[1], reference, sessionKey: SESSION, nowMs: BASE + 60_000 };
  assert.equal((await checkAndRecordUse(atomic, input)).ok, true);
});

test('checkAndRecordUse lets only the limit through when requests run at the same time', async () => {
  const budgets = [{ name: 'writes', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 86400, per: 'session' }];
  const store = new MemoryStore();
  const input = { budgets, method: BOOK[0], path: BOOK[1], reference: newReference(), sessionKey: SESSION, nowMs: BASE };
  const results = await Promise.all(Array.from({ length: 5 }, () => checkAndRecordUse(store, input)));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.budget === 'writes').length, 4);
});

test('checkAndRecordUse uses checkBudgets and recordUse when the store has no addUsesIfRoom', async () => {
  const store = spyStore();
  const budgets = [{ name: 'reads', actions: ['GET /api/restaurants'], limit: 1, windowSeconds: 30, per: 'pass' }];
  const input = { budgets, method: READ[0], path: READ[1], reference: newReference(), sessionKey: SESSION, nowMs: BASE };
  assert.equal((await checkAndRecordUse(store, input)).ok, true);
  const second = await checkAndRecordUse(store, input);
  assert.equal(second.ok, false);
  assert.equal(second.retryAfter, 30);
  assert.deepEqual(store.calls.map(([name]) => name), ['countUses', 'addUse', 'countUses']);
});

test('checkAndRecordUse does not call the store when no budget covers the action', async () => {
  const store = { addUsesIfRoom: async () => assert.fail('the store must not be called') };
  const budgets = [{ name: 'writes', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 60, per: 'session' }];
  const input = { budgets, method: READ[0], path: READ[1], reference: newReference(), sessionKey: SESSION, nowMs: BASE };
  assert.deepEqual(await checkAndRecordUse(store, input), { ok: true, applied: [] });
});

test('checkAndRecordUse rejects a store result with the wrong number of counts', async () => {
  const store = { addUsesIfRoom: async () => [] };
  const budgets = [{ name: 'reads', actions: '*', limit: 1, windowSeconds: 60, per: 'session' }];
  const input = { budgets, method: READ[0], path: READ[1], sessionKey: SESSION, nowMs: BASE };
  await assert.rejects(checkAndRecordUse(store, input), /1 count for each entry/);
});
