// Tests for the Cloudflare Worker adapter (src/cloudflare/worker.js).
// The tests run in Node.js. They give the adapter a small fake store,
// so they do not need workerd or a Durable Object.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withAgentLane, PASS_BUDGET_NAME, MIN_SECRET_BYTES } from '../src/cloudflare/worker.js';
import { hashReference, newReference, signProof, memoryStores, createMemoryStore } from '../src/core/index.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://shop.example';
// A time at the start of a 60-second window. Thus each budget window starts at T0.
const T0 = 1_800_000_000_000;
const SCOPE = ['GET /api/items', 'POST /api/orders'];
const BUDGETS = [
  { name: 'orders', actions: ['POST /api/orders'], limit: 2, windowSeconds: 60, per: 'session' },
  { name: 'all', actions: '*', limit: 10, windowSeconds: 60, per: 'pass' },
];

// A small store that implements the store interface in memory.
class FakeStore {
  passes = new Map();
  uses = [];
  events = [];
  pruned = [];
  async putPass({ referenceHash, sessionKey, expiresAt }) {
    this.passes.set(referenceHash, { sessionKey, expiresAt });
  }
  async getPass(referenceHash) {
    const pass = this.passes.get(referenceHash);
    return pass ? { ...pass } : null;
  }
  async countUses(key, sinceMs) {
    return this.uses.filter((use) => use.key === key && use.at > sinceMs).length;
  }
  async addUse(key, at) {
    this.uses.push({ key, at });
  }
  async prune(nowMs) {
    this.pruned.push(nowMs);
  }
  sessionKeys = [];
  async logActivity(event, { sessionKey } = {}) {
    this.events.push(event);
    this.sessionKeys.push(sessionKey);
  }
  async listActivity({ limit = 50 } = {}) {
    return this.events.slice(-limit).reverse();
  }
}

function okHandler(calls) {
  return async (request) => {
    calls.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function setup({ handler, options = {}, env: envExtra = {} } = {}) {
  const clock = { ms: T0 };
  const stores = new Map();
  const calls = [];
  const sessionCalls = [];
  const events = [];
  const lane = withAgentLane(handler ?? okHandler(calls), {
    secret: (env) => env.AGENTLANE_SECRET,
    session: async (request) => {
      sessionCalls.push(request.url);
      const match = /sid=([a-z0-9]+)/.exec(request.headers.get('Cookie') ?? '');
      return match ? `session-${match[1]}` : null;
    },
    scope: SCOPE,
    budgets: BUDGETS,
    store: (_env, sessionKey) => {
      if (!stores.has(sessionKey)) stores.set(sessionKey, new FakeStore());
      return stores.get(sessionKey);
    },
    onAgentRequest: (event) => events.push(event),
    now: () => clock.ms,
    ...options,
  });
  const env = { AGENTLANE_SECRET: SECRET, ...envExtra };
  const fetch = (path, init = {}, ctx = undefined) => lane.fetch(new Request(ORIGIN + path, init), env, ctx);
  return { lane, fetch, clock, stores, calls, sessionCalls, events, env };
}

async function getPass(t, sid = 'alice', headers = {}) {
  const res = await t.fetch('/agentlane/pass', {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: `sid=${sid}`, 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
  return { res, body: await res.json() };
}

function laneInit(pass, method, path, { sid = 'alice', reference, proof, body } = {}) {
  const key = `${method} ${path.split('?')[0]}`;
  const headers = {
    Cookie: `sid=${sid}`,
    'X-Agent-Session': reference ?? pass.reference,
    'X-Agent-Proof': proof ?? pass.proofs[key] ?? pass.proofs[SCOPE[0]],
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { method, headers, body };
}

async function errorOf(res) {
  const body = await res.json();
  return { status: res.status, code: body.code, body };
}

describe('requests without lane headers', () => {
  test('go to the handler with no change', async () => {
    const seen = [];
    const response = new Response('human page');
    const t = setup({
      handler: async (request) => {
        seen.push(request);
        return response;
      },
    });
    const request = new Request(`${ORIGIN}/api/items`, { headers: { Cookie: 'sid=alice' } });
    const result = await t.lane.fetch(request, t.env, undefined);
    assert.equal(result, response);
    assert.equal(seen[0], request);
    assert.equal(t.sessionCalls.length, 0);
    assert.equal(t.events.length, 0);
  });

  test('accept a handler object with a fetch method', async () => {
    const calls = [];
    const t = setup({ handler: { fetch: okHandler(calls) } });
    const res = await t.fetch('/anything');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  test('preserve other Worker handlers with their arguments, result and original this', async () => {
    const seen = [];
    const result = Promise.resolve('finished');
    const events = ['scheduled', 'queue', 'email', 'tail', 'tailStream', 'trace'];
    const handler = { fetch: okHandler([]) };
    for (const name of events) {
      handler[name] = function (...args) {
        seen.push({ name, receiver: this, args });
        return result;
      };
    }
    Object.freeze(handler);
    const t = setup({ handler });
    const event = {};
    const ctx = {};
    for (const name of events) {
      assert.equal(typeof t.lane[name], 'function', name);
      assert.equal(t.lane[name](event, t.env, ctx), result);
      const call = seen.at(-1);
      assert.equal(call.name, name);
      assert.equal(call.receiver, handler);
      assert.deepEqual(call.args, [event, t.env, ctx]);
    }
    assert.equal(t.sessionCalls.length, 0);
    assert.equal(t.events.length, 0);
    assert.equal((await t.fetch('/anything')).status, 200);
    assert.equal((await getPass(t)).res.status, 201);
  });

  test('preserve inherited Worker handlers and their state', async () => {
    class Site {
      #runs = 0;
      scheduled() { this.#runs++; }
      fetch() { return new Response(String(this.#runs)); }
    }
    const t = setup({ handler: new Site() });
    assert.equal(typeof t.lane.scheduled, 'function');
    t.lane.scheduled();
    assert.equal(await (await t.fetch('/anything')).text(), '1');
    assert.equal(t.lane.queue, undefined);
  });
});

describe('the pass request', () => {
  test('issues a pass with 1 proof for each action', async () => {
    const t = setup();
    const { res, body } = await getPass(t);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Object.keys(body).sort(), ['budgets', 'expiresAt', 'proofs', 'reference', 'scope']);
    assert.match(body.reference, /^[a-f0-9]{64}$/);
    assert.deepEqual(body.scope, SCOPE);
    assert.deepEqual(Object.keys(body.proofs).sort(), [...SCOPE].sort());
    for (const proof of Object.values(body.proofs)) assert.match(proof, /^1800000000-/);
    assert.equal(body.expiresAt, T0 + 900_000);
    assert.deepEqual(
      body.budgets.map((budget) => budget.name),
      BUDGETS.map((budget) => budget.name),
    );
    assert.equal(t.calls.length, 0, 'the handler does not get the pass request');
  });

  test('keeps only the hash of the reference in the store', async () => {
    const t = setup();
    const { body } = await getPass(t);
    const store = t.stores.get('session-alice');
    const hash = await hashReference(body.reference);
    assert.deepEqual(await store.getPass(hash), { sessionKey: 'session-alice', expiresAt: body.expiresAt });
    assert.equal(await store.getPass(body.reference), null);
    assert.ok(!JSON.stringify(store.events).includes(body.reference));
    assert.deepEqual(store.pruned, [T0]);
  });

  test('logs the pass in the activity log with the first 8 characters of the reference', async () => {
    const t = setup();
    const { body } = await getPass(t);
    const [event] = t.stores.get('session-alice').events;
    assert.deepEqual(event, {
      at: T0,
      lane: 'agent',
      action: 'POST /agentlane/pass',
      status: 201,
      code: null,
      pass: body.reference.slice(0, 8),
    });
  });

  test('needs POST, and the hook gets the event', async () => {
    const t = setup();
    const res = await t.fetch('/agentlane/pass', { headers: { Origin: ORIGIN, Cookie: 'sid=alice' } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'POST');
    assert.deepEqual(t.events, [
      { at: T0, lane: 'agent', action: 'GET /agentlane/pass', status: 405, code: 'method', pass: null },
    ]);
    assert.equal(t.sessionCalls.length, 0, 'the adapter does not look up the session for this event');
  });

  test('needs the site origin', async () => {
    const t = setup();
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }]) {
      const res = await t.fetch('/agentlane/pass', { method: 'POST', headers: { Cookie: 'sid=alice', ...headers } });
      assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), {
        status: 403,
        code: 'origin',
      });
    }
    const res = await t.fetch('/agentlane/pass', { method: 'POST', headers: { Cookie: 'sid=alice' } });
    assert.equal(res.status, 403);
    assert.equal(t.sessionCalls.length, 0, 'the origin check comes before the session check');
  });

  test('uses allowedOrigin when it is set', async () => {
    const t = setup({ options: { allowedOrigin: (env) => env.SITE_ORIGIN }, env: { SITE_ORIGIN: 'https://www.shop.example' } });
    assert.equal((await getPass(t)).res.status, 403);
    assert.equal((await getPass(t, 'alice', { Origin: 'https://www.shop.example' })).res.status, 201);
  });

  test('needs a signed-in session', async () => {
    const t = setup();
    const res = await t.fetch('/agentlane/pass', { method: 'POST', headers: { Origin: ORIGIN } });
    assert.deepEqual((await errorOf(res)).code, 'session');
    assert.equal(res.status, 401);
  });

  test('limits pass requests to 5 in 30 seconds for each session', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) assert.equal((await getPass(t)).res.status, 201);
    const { res, body } = await getPass(t);
    assert.equal(res.status, 429);
    assert.equal(body.code, 'budget');
    assert.equal(body.budget, PASS_BUDGET_NAME);
    assert.equal(res.headers.get('Retry-After'), '30');
    assert.equal((await getPass(t, 'bob')).res.status, 201, 'each session has its own limit');
    t.clock.ms += 30_000;
    assert.equal((await getPass(t)).res.status, 201);
  });

  test('has no pass limit when passLimit is null', async () => {
    const t = setup({ options: { passLimit: null } });
    for (let i = 0; i < 8; i += 1) assert.equal((await getPass(t)).res.status, 201);
  });

  test('responds with 503 when the secret is missing', async () => {
    const t = setup({ env: { AGENTLANE_SECRET: undefined } });
    const original = console.error;
    console.error = () => {};
    try {
      const { res, body } = await getPass(t);
      assert.equal(res.status, 503);
      assert.equal(body.code, 'unavailable');
    } finally {
      console.error = original;
    }
  });

  test(`responds with 503 when the secret has fewer than ${MIN_SECRET_BYTES} bytes`, async () => {
    const short = 'x'.repeat(MIN_SECRET_BYTES - 1);
    const t = setup({ env: { AGENTLANE_SECRET: short } });
    const reference = newReference();
    const proof = await signProof(short, reference, 'GET', '/api/items', T0 / 1000);
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const { res, body } = await getPass(t);
      assert.deepEqual([res.status, body.code], [503, 'unavailable']);
      // A proof that the short secret signed does not pass check 3 either.
      const lane = await t.fetch('/api/items', { headers: { Cookie: 'sid=alice', 'X-Agent-Session': reference, 'X-Agent-Proof': proof } });
      assert.deepEqual(await errorOf(lane).then(({ status, code }) => [status, code]), [503, 'unavailable']);
    } finally {
      console.error = original;
    }
    assert.ok(logged.every((line) => line.includes('the secret is too short')));
    assert.ok(logged.every((line) => !line.includes(short)), 'the log never has the secret');
    assert.equal(t.calls.length, 0);
    // 32 bytes is enough.
    const ok = setup({ env: { AGENTLANE_SECRET: 'x'.repeat(MIN_SECRET_BYTES) } });
    assert.equal((await getPass(ok)).res.status, 201);
  });
});

describe('a valid lane request', () => {
  test('goes to the handler with RateLimit headers and an activity event', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const request = new Request(`${ORIGIN}/api/orders`, laneInit(pass, 'POST', '/api/orders', { body: '{"item":1}' }));
    const res = await t.lane.fetch(request, t.env, undefined);
    assert.equal(res.status, 200);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0], request, 'the handler gets the original request');
    assert.equal(await t.calls[0].text(), '{"item":1}', 'the adapter does not read the body');
    assert.equal(res.headers.get('RateLimit-Policy'), '"orders";q=2;w=60, "all";q=10;w=60');
    assert.equal(res.headers.get('RateLimit'), '"orders";r=1;t=60, "all";r=9;t=60');
    const last = t.stores.get('session-alice').events.at(-1);
    assert.deepEqual(last, {
      at: T0,
      lane: 'agent',
      action: 'POST /api/orders',
      status: 200,
      code: null,
      pass: pass.reference.slice(0, 8),
    });
  });

  test('ignores the query string when it finds the action', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const res = await t.fetch('/api/items?q=red&page=2', laneInit(pass, 'GET', '/api/items?q=red&page=2'));
    assert.equal(res.status, 200);
  });

  test('copies a response with immutable headers to add the RateLimit headers', async () => {
    const t = setup({ handler: async () => Response.redirect(`${ORIGIN}/done`, 302) });
    const { body: pass } = await getPass(t);
    const res = await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), `${ORIGIN}/done`);
    assert.match(res.headers.get('RateLimit'), /"all";r=9;t=60/);
  });

  test('accepts custom header names', async () => {
    const t = setup({ options: { headers: { reference: 'X-Lane-Ref', proof: 'X-Lane-Proof' } } });
    const { body: pass } = await getPass(t);
    const res = await t.fetch('/api/items', {
      headers: { Cookie: 'sid=alice', 'X-Lane-Ref': pass.reference, 'X-Lane-Proof': pass.proofs['GET /api/items'] },
    });
    assert.equal(res.status, 200);
    // The default names are not lane headers now. The request goes to the handler as a human request.
    const human = await t.fetch('/api/items', { headers: { 'X-Agent-Session': 'x' } });
    assert.equal(human.status, 200);
    assert.equal(t.events.at(-1).action, 'GET /api/items');
  });
});

describe('the checks, in order', () => {
  test('1. both lane headers must be present and well-formed', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const proof = pass.proofs['GET /api/items'];
    const cases = [
      { 'X-Agent-Session': pass.reference },
      { 'X-Agent-Proof': proof },
      { 'X-Agent-Session': pass.reference.toUpperCase(), 'X-Agent-Proof': proof },
      { 'X-Agent-Session': pass.reference.slice(1), 'X-Agent-Proof': proof },
      { 'X-Agent-Session': pass.reference, 'X-Agent-Proof': proof.replace('%3D', '=') },
      { 'X-Agent-Session': pass.reference, 'X-Agent-Proof': `1-${proof.split('-')[1]}` },
      { 'X-Agent-Session': '', 'X-Agent-Proof': '' },
    ];
    const before = t.sessionCalls.length;
    for (const headers of cases) {
      const res = await t.fetch('/api/items', { headers: { Cookie: 'sid=alice', ...headers } });
      const { status, code } = await errorOf(res);
      assert.deepEqual({ status, code }, { status: 403, code: 'lane-headers' }, JSON.stringify(Object.keys(headers)));
    }
    // 2 copies of a header arrive joined with ", ", so they are not well-formed.
    const doubled = new Headers({ Cookie: 'sid=alice', 'X-Agent-Proof': proof });
    doubled.append('X-Agent-Session', pass.reference);
    doubled.append('X-Agent-Session', pass.reference);
    assert.equal((await errorOf(await t.fetch('/api/items', { headers: doubled }))).code, 'lane-headers');
    assert.equal(t.sessionCalls.length, before, 'the session is not checked');
    assert.equal(t.calls.length, 0, 'the request never goes to the human lane');
  });

  test('2. the action must be in the scope', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const proof = pass.proofs['GET /api/items'];
    for (const [method, path] of [['DELETE', '/api/items'], ['GET', '/api/orders'], ['GET', '/admin']]) {
      const res = await t.fetch(path, laneInit(pass, method, path, { proof }));
      assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), { status: 403, code: 'scope' });
    }
    assert.equal(t.calls.length, 0);
  });

  test('2. the scope check comes before the proof check', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const res = await t.fetch('/api/secret', laneInit(pass, 'GET', '/api/secret', { proof: pass.proofs['GET /api/items'] }));
    assert.equal((await errorOf(res)).code, 'scope');
  });

  test('3. the proof must be valid for this reference, action and time', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const other = await getPass(t);
    const cases = [
      ['proof of another action', { proof: pass.proofs['GET /api/items'] }],
      ['proof of another pass', { proof: other.body.proofs['POST /api/orders'] }],
      ['proof with another secret', { proof: await signProof('another-secret', pass.reference, 'POST', '/api/orders', 1_800_000_000) }],
      ['proof from the future', { proof: await signProof(SECRET, pass.reference, 'POST', '/api/orders', 1_800_000_060) }],
    ];
    for (const [name, override] of cases) {
      const res = await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', override));
      assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), { status: 403, code: 'proof' }, name);
    }
    t.clock.ms = T0 + 900_000;
    const expired = await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders'));
    assert.equal((await errorOf(expired)).code, 'proof');
    assert.equal(t.calls.length, 0);
  });

  test('3. the proof check comes before the session check', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const before = t.sessionCalls.length;
    const res = await t.fetch('/api/orders', {
      method: 'POST',
      headers: { 'X-Agent-Session': pass.reference, 'X-Agent-Proof': pass.proofs['GET /api/items'] },
    });
    assert.equal((await errorOf(res)).code, 'proof');
    assert.equal(t.sessionCalls.length, before);
  });

  test('4. the person must have a valid session', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const res = await t.fetch('/api/items', {
      headers: { 'X-Agent-Session': pass.reference, 'X-Agent-Proof': pass.proofs['GET /api/items'] },
    });
    assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), { status: 401, code: 'session' });
    assert.equal(t.calls.length, 0);
  });

  test('5. the pass must exist in the store', async () => {
    const t = setup();
    await getPass(t);
    const reference = newReference();
    const proof = await signProof(SECRET, reference, 'GET', '/api/items', 1_800_000_000);
    const res = await t.fetch('/api/items', { headers: { Cookie: 'sid=alice', 'X-Agent-Session': reference, 'X-Agent-Proof': proof } });
    assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), { status: 403, code: 'pass' });
  });

  test('5. the pass must belong to the session', async () => {
    const t = setup();
    const { body: pass } = await getPass(t, 'alice');
    await getPass(t, 'bob');
    const res = await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items', { sid: 'bob' }));
    assert.equal((await errorOf(res)).code, 'pass');
    assert.equal(t.calls.length, 0);
  });

  test('5. the pass must not be expired', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    // Make the stored pass expire before its proofs do.
    const store = t.stores.get('session-alice');
    await store.putPass({ referenceHash: await hashReference(pass.reference), sessionKey: 'session-alice', expiresAt: T0 + 1000 });
    t.clock.ms = T0 + 1000;
    const res = await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'));
    assert.equal((await errorOf(res)).code, 'pass');
  });

  test('6. every budget that covers the action must have room', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const order = () => t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', { body: '{}' }));
    assert.equal((await order()).status, 200);
    t.clock.ms = T0 + 15_000;
    assert.equal((await order()).status, 200);
    const res = await order();
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.deepEqual(
      { code: body.code, budget: body.budget, retryAfter: body.retryAfter },
      { code: 'budget', budget: 'orders', retryAfter: 45 },
    );
    assert.equal(res.headers.get('Retry-After'), '45');
    assert.equal(res.headers.get('RateLimit'), '"orders";r=0;t=45, "all";r=8;t=45');
    assert.equal(t.calls.length, 2);
    assert.equal(t.stores.get('session-alice').events.at(-1).status, 429);

    // Reads have their own room in the "all" budget.
    assert.equal((await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'))).status, 200);

    // A new window has room again.
    t.clock.ms = T0 + 60_000;
    assert.equal((await order()).status, 200);
  });

  test('6. the budget counts only requests that pass all checks', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    const store = t.stores.get('session-alice');
    const usesAfterPass = store.uses.length;
    // A rejected request (wrong proof) does not count.
    await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', { proof: pass.proofs['GET /api/items'] }));
    assert.equal(store.uses.length, usesAfterPass);
    // 2 good orders count. The third gets HTTP 429 and does not count.
    for (let i = 0; i < 3; i += 1) await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders'));
    const orderUses = store.uses.filter((use) => use.key.startsWith('budget:orders:'));
    assert.equal(orderUses.length, 2);
  });

  test('6. a budget with per "pass" counts each pass apart', async () => {
    const t = setup({
      options: {
        budgets: [{ name: 'reads', actions: ['GET /api/items'], limit: 1, windowSeconds: 60, per: 'pass' }],
      },
    });
    const first = (await getPass(t)).body;
    const second = (await getPass(t)).body;
    assert.equal((await t.fetch('/api/items', laneInit(first, 'GET', '/api/items'))).status, 200);
    assert.equal((await t.fetch('/api/items', laneInit(first, 'GET', '/api/items'))).status, 429);
    assert.equal((await t.fetch('/api/items', laneInit(second, 'GET', '/api/items'))).status, 200);
  });

  test('7. a handler error is logged with status 500 and thrown again', async () => {
    const t = setup({
      handler: async () => {
        throw new Error('broken handler');
      },
    });
    const { body: pass } = await getPass(t);
    await assert.rejects(t.fetch('/api/items', laneInit(pass, 'GET', '/api/items')), /broken handler/);
    const last = t.stores.get('session-alice').events.at(-1);
    assert.deepEqual({ status: last.status, code: last.code }, { status: 500, code: 'handler' });
  });

  test('a store failure gives HTTP 503 and never reaches the handler', async () => {
    const t = setup({
      options: {
        store: () => ({
          getPass: async () => {
            throw new Error('store is down');
          },
        }),
        passLimit: null,
      },
    });
    const reference = newReference();
    const proof = await signProof(SECRET, reference, 'GET', '/api/items', 1_800_000_000);
    const original = console.error;
    console.error = () => {};
    try {
      const res = await t.fetch('/api/items', { headers: { Cookie: 'sid=alice', 'X-Agent-Session': reference, 'X-Agent-Proof': proof } });
      assert.deepEqual(await errorOf(res).then(({ status, code }) => ({ status, code })), { status: 503, code: 'unavailable' });
    } finally {
      console.error = original;
    }
    assert.equal(t.calls.length, 0);
  });

  test('error responses are JSON with error and code, and are not cached', async () => {
    const t = setup();
    const res = await t.fetch('/api/items', { headers: { 'X-Agent-Session': 'bad' } });
    assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
    assert.equal(typeof body.error, 'string');
  });
});

describe('activity', () => {
  test('the hook gets every lane event, also before the session is known', async () => {
    const t = setup();
    await t.fetch('/api/items', { headers: { 'X-Agent-Session': 'bad' } });
    assert.deepEqual(t.events.at(-1), {
      at: T0,
      lane: 'agent',
      action: 'GET /api/items',
      status: 403,
      code: 'lane-headers',
      pass: null,
    });
  });

  test('a hook error does not change the response', async () => {
    const t = setup({
      options: {
        onAgentRequest: () => {
          throw new Error('hook failed');
        },
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const { res, body: pass } = await getPass(t);
      assert.equal(res.status, 201);
      assert.equal((await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'))).status, 200);
    } finally {
      console.error = original;
    }
  });

  test('the store write uses ctx.waitUntil when the context has it', async () => {
    const t = setup();
    const waiting = [];
    const ctx = { waitUntil: (promise) => waiting.push(promise) };
    const res = await t.fetch(
      '/agentlane/pass',
      { method: 'POST', headers: { Origin: ORIGIN, Cookie: 'sid=alice' } },
      ctx,
    );
    assert.equal(res.status, 201);
    assert.equal(waiting.length, 1);
    await Promise.all(waiting);
    assert.equal(t.stores.get('session-alice').events.length, 1);
  });

  test('GET /agentlane/activity returns the events of the person, newest first', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    t.clock.ms += 1000;
    await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'));
    t.clock.ms += 1000;
    // A pass that the site never issued fails at check 5. The session is known, so the log has it.
    const unknown = newReference();
    const proof = await signProof(SECRET, unknown, 'POST', '/api/orders', Math.floor(t.clock.ms / 1000));
    await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', { reference: unknown, proof }));
    // A bad proof fails at check 3, before the session check. Only the hook gets it.
    await t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', { proof: pass.proofs['GET /api/items'] }));
    assert.equal(t.events.at(-1).code, 'proof');
    await getPass(t, 'bob');

    const res = await t.fetch('/agentlane/activity', { headers: { Cookie: 'sid=alice' } });
    assert.equal(res.status, 200);
    const text = await res.clone().text();
    const { events } = await res.json();
    assert.deepEqual(
      events.map((event) => [event.action, event.status, event.code, event.pass]),
      [
        ['POST /api/orders', 403, 'pass', unknown.slice(0, 8)],
        ['GET /api/items', 200, null, pass.reference.slice(0, 8)],
        ['POST /agentlane/pass', 201, null, pass.reference.slice(0, 8)],
      ],
    );
    assert.ok(!text.includes(pass.reference), 'never the full reference');
    assert.ok(!text.includes('session-alice'), 'never the session key');
    assert.equal(t.calls.length, 1);
  });

  test('the activity request needs a session and GET, and accepts a limit', async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) await getPass(t);
    assert.equal((await t.fetch('/agentlane/activity')).status, 401);
    assert.equal((await t.fetch('/agentlane/activity', { method: 'POST', headers: { Cookie: 'sid=alice' } })).status, 405);
    const res = await t.fetch('/agentlane/activity?limit=2', { headers: { Cookie: 'sid=alice' } });
    assert.equal((await res.json()).events.length, 2);
  });
});

describe('1 store for all sessions', () => {
  test('keeps the activity log and the passes of each session apart', async () => {
    const shared = createMemoryStore();
    const t = setup({ options: { store: () => shared, passLimit: null } });
    const { body: alice } = await getPass(t, 'alice');
    assert.equal((await t.fetch('/api/orders', laneInit(alice, 'POST', '/api/orders', { body: '{}' }))).status, 200);

    // Bob reads the activity log. He does not see the events of Alice.
    await getPass(t, 'bob');
    const res = await t.fetch('/agentlane/activity', { headers: { Cookie: 'sid=bob' } });
    const { events } = await res.json();
    assert.deepEqual(events.map((event) => event.action), ['POST /agentlane/pass']);
    assert.ok(!JSON.stringify(events).includes(alice.reference.slice(0, 8)));

    // Mallory gets many passes. They do not remove the pass of Alice.
    for (let i = 0; i < 60; i += 1) await getPass(t, 'mallory');
    assert.equal((await t.fetch('/api/items', laneInit(alice, 'GET', '/api/items'))).status, 200);

    const own = await t.fetch('/agentlane/activity', { headers: { Cookie: 'sid=alice' } });
    assert.deepEqual(
      (await own.json()).events.map((event) => event.action),
      ['GET /api/items', 'POST /api/orders', 'POST /agentlane/pass'],
    );
  });

  test('the store gets the session key with each event', async () => {
    const t = setup();
    const { body: pass } = await getPass(t);
    await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'));
    const store = t.stores.get('session-alice');
    assert.deepEqual(store.sessionKeys, ['session-alice', 'session-alice']);
    assert.ok(store.events.every((event) => !('sessionKey' in event)), 'the event itself has no session key');
  });
});

describe('the default store', () => {
  test('uses 1 Durable Object for each session from env.AGENTLANE', async () => {
    const names = [];
    const objects = new Map();
    const namespace = {
      idFromName: (name) => {
        names.push(name);
        return `id:${name}`;
      },
      get: (id) => {
        if (!objects.has(id)) objects.set(id, new FakeStore());
        return objects.get(id);
      },
    };
    const t = setup({ options: { store: undefined }, env: { AGENTLANE: namespace } });
    const { res, body: pass } = await getPass(t);
    assert.equal(res.status, 201);
    assert.equal((await t.fetch('/api/items', laneInit(pass, 'GET', '/api/items'))).status, 200);
    assert.deepEqual([...new Set(names)], ['session-alice']);
    assert.equal(objects.get('id:session-alice').passes.size, 1);
  });

  test('responds with 503 when the binding is missing', async () => {
    const t = setup({ options: { store: undefined } });
    const original = console.error;
    console.error = () => {};
    try {
      const { res } = await getPass(t);
      assert.equal(res.status, 503);
    } finally {
      console.error = original;
    }
  });
});

describe('options', () => {
  const base = { secret: () => SECRET, session: async () => null, scope: SCOPE };
  const cases = [
    ['no secret function', { secret: 'text' }],
    ['no session function', { session: undefined }],
    ['an empty scope', { scope: [] }],
    ['an action with a query string', { scope: ['GET /api/items?x=1'] }],
    ['a budget for an action outside the scope', { budgets: [{ name: 'x', actions: ['GET /other'], limit: 1, windowSeconds: 1 }] }],
    ['a reserved budget name', { budgets: [{ name: PASS_BUDGET_NAME, actions: '*', limit: 1, windowSeconds: 1 }] }],
    ['the pass request in the scope', { scope: ['POST /agentlane/pass'] }],
    ['a bad TTL', { ttlSeconds: 0 }],
    ['a TTL that is too long', { ttlSeconds: 86401 }],
    ['the same header twice', { headers: { reference: 'X-A', proof: 'x-a' } }],
    ['a bad header name', { headers: { proof: 'X Agent' } }],
    ['a bad pass path', { passPath: 'agentlane/pass' }],
    ['the same pass and activity path', { activityPath: '/agentlane/pass' }],
    ['a bad pass limit', { passLimit: { limit: 0, windowSeconds: 30 } }],
    ['allowedOrigin as text', { allowedOrigin: 'https://shop.example' }],
  ];
  for (const [name, change] of cases) {
    test(`reject ${name}`, () => {
      assert.throws(() => withAgentLane(async () => new Response(''), { ...base, ...change }), TypeError);
    });
  }

  test('reject a handler that is not a function or a fetch object', () => {
    assert.throws(() => withAgentLane({}, base), TypeError);
  });
});

describe('requests at the same time', () => {
  test('cannot go over a budget when the store has addUsesIfRoom', async () => {
    const calls = [];
    const t = setup({ handler: okHandler(calls), options: { store: memoryStores() } });
    const { body: pass } = await getPass(t);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => t.fetch('/api/orders', laneInit(pass, 'POST', '/api/orders', { body: '{}' }))),
    );
    const statuses = responses.map((res) => res.status).sort();
    // The "orders" budget accepts 2 requests in each session.
    assert.deepEqual(statuses, [200, 200, 429, 429, 429, 429]);
    assert.equal(calls.length, 2);
  });
});
