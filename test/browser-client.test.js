// Tests for createAgentLaneClient (src/browser/agentlane.js).
// The tests run in Node.js. A fake fetch plays the site. The tests mock
// Date to move the clock of the page.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentLaneClient } from '../src/browser/agentlane.js';
import { issuePass, memoryStores } from '../src/core/index.js';
import { withAgentLane } from '../src/cloudflare/worker.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const SCOPE = ['GET /api/notes', 'POST /api/notes'];
const T0 = 1_800_000_000_000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// A fake site. It issues real passes. "lane" makes the responses to the tool requests.
function fakeSite({ scope = SCOPE, ttlSeconds = 900, serverNow = () => Date.now(), lane, passAnswer } = {}) {
  const calls = [];
  const passCalls = [];
  const laneCalls = [];
  const passes = [];
  async function fetchImpl(url, init = {}) {
    const call = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    if (new URL(url, 'http://x.invalid').pathname === '/agentlane/pass') {
      passCalls.push(call);
      if (passAnswer) {
        const answer = await passAnswer(call, passCalls.length);
        if (answer) return answer;
      }
      const pass = await issuePass({ secret: SECRET, scope, ttlSeconds, nowMs: serverNow() });
      passes.push(pass);
      return json(pass, 201);
    }
    laneCalls.push(call);
    if (lane) return lane(call, laneCalls.length);
    return json({ ok: true });
  }
  return { fetchImpl, calls, passCalls, laneCalls, passes };
}

// Replace globals for 1 test, and put the old values back after it.
function setGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    });
  }
}

describe('createAgentLaneClient: requests', () => {
  test('gets a pass, then sends the reference and the proof of the action', async (t) => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });

    const response = await lane.fetch('/api/notes?limit=5');
    assert.equal(response.status, 200);

    assert.equal(site.passCalls.length, 1);
    const passCall = site.passCalls[0];
    assert.equal(passCall.url, '/agentlane/pass');
    assert.equal(passCall.init.method, 'POST');
    assert.equal(passCall.init.body, '{}');
    assert.equal(passCall.init.credentials, 'same-origin');
    assert.equal(passCall.init.cache, 'no-store');
    assert.equal(passCall.headers.get('Content-Type'), 'application/json');

    const [call] = site.laneCalls;
    const pass = site.passes[0];
    assert.equal(call.url, '/api/notes?limit=5');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.headers.get('X-Agent-Session'), pass.reference);
    assert.equal(call.headers.get('X-Agent-Proof'), pass.proofs['GET /api/notes']);
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
  });

  test('changes the method to upper-case and keeps the other options', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });

    await lane.fetch('/api/notes', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Proof': 'old value' },
      body: JSON.stringify({ text: 'hello' }),
      credentials: 'include',
    });
    const [call] = site.laneCalls;
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.body, '{"text":"hello"}');
    assert.equal(call.headers.get('Content-Type'), 'application/json');
    assert.equal(call.headers.get('X-Agent-Proof'), site.passes[0].proofs['POST /api/notes']);
    assert.equal(call.init.credentials, 'same-origin');
  });

  test('uses 1 pass for many requests', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await lane.fetch('/api/notes');
    await lane.fetch('/api/notes', { method: 'POST', body: '{}' });
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 1);
    assert.equal(site.laneCalls.length, 3);
  });

  test('sends only 1 pass request when many requests start at the same time', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const responses = await Promise.all([lane.fetch('/api/notes'), lane.fetch('/api/notes'), lane.pass()]);
    assert.equal(responses.length, 3);
    assert.equal(site.passCalls.length, 1);
    const references = new Set(site.laneCalls.map((call) => call.headers.get('X-Agent-Session')));
    assert.deepEqual([...references], [site.passes[0].reference]);
  });

  test('stops with an error if the action is not in the scope, and sends nothing', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await assert.rejects(lane.fetch('/api/notes/1', { method: 'DELETE' }), {
      message: 'agentlane: action not in scope: DELETE /api/notes/1',
    });
    assert.equal(site.laneCalls.length, 0);
  });

  test('uses custom header names and a custom pass path', async () => {
    const site = fakeSite();
    const fetchImpl = (url, init) => site.fetchImpl(url === '/api/agent-session' ? '/agentlane/pass' : url, init);
    const lane = createAgentLaneClient({
      fetchImpl,
      passUrl: '/api/agent-session',
      headers: { reference: 'X-Lane-Ref', proof: 'X-Lane-Proof' },
    });
    await lane.fetch('/api/notes');
    const [call] = site.laneCalls;
    assert.equal(call.headers.get('X-Lane-Ref'), site.passes[0].reference);
    assert.equal(call.headers.get('X-Lane-Proof'), site.passes[0].proofs['GET /api/notes']);
    assert.equal(call.headers.get('X-Agent-Session'), null);
  });

  test('uses globalThis.fetch when there is no fetchImpl', async (t) => {
    const site = fakeSite();
    setGlobals(t, { fetch: site.fetchImpl });
    const lane = createAgentLaneClient();
    await lane.fetch('/api/notes');
    assert.equal(site.laneCalls.length, 1);
  });
});

describe('createAgentLaneClient: pass lifetime', () => {
  test('gets a new pass when less than refreshMarginMs is left', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const site = fakeSite({ ttlSeconds: 60 });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl, refreshMarginMs: 5000 });

    await lane.fetch('/api/notes');
    t.mock.timers.tick(54_000); // 6 seconds left
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 1);

    t.mock.timers.tick(2_000); // 4 seconds left
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 2);
    assert.equal(site.laneCalls[2].headers.get('X-Agent-Session'), site.passes[1].reference);
  });

  test('measures the lifetime with the clock of the page, not with expiresAt', async (t) => {
    // The clock of the page is 1 hour ahead of the clock of the server.
    t.mock.timers.enable({ apis: ['Date'], now: T0 + 3_600_000 });
    const site = fakeSite({ serverNow: () => Date.now() - 3_600_000 });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });

    await lane.fetch('/api/notes');
    t.mock.timers.tick(60_000);
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 1, 'the client must not get a new pass for each request');

    t.mock.timers.tick(840_000); // 15 minutes after the first pass
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 2);
  });

  test('pass() returns the same frozen pass until it expires', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const first = await lane.pass();
    const second = await lane.pass();
    assert.equal(first, second);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.proofs));
    assert.ok(Object.isFrozen(first.scope));
    assert.deepEqual(first.scope, SCOPE);
    assert.equal(first.reference, site.passes[0].reference);
  });

  test('clear() forgets the pass', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await lane.fetch('/api/notes');
    lane.clear();
    await lane.fetch('/api/notes');
    assert.equal(site.passCalls.length, 2);
    assert.equal(site.laneCalls[1].headers.get('X-Agent-Session'), site.passes[1].reference);
  });

  test('clear() during a pass request does not keep the result', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const site = fakeSite({
      passAnswer: async (_call, count) => {
        if (count === 1) await gate;
      },
    });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const early = lane.pass();
    lane.clear();
    release();
    const old = await early;
    const fresh = await lane.pass();
    assert.notEqual(fresh.reference, old.reference);
    assert.equal(site.passCalls.length, 2);
  });

  test('accepts a pass with no scope field (tableforagents.com format)', async () => {
    const site = fakeSite({
      passAnswer: async () => {
        const pass = await issuePass({ secret: SECRET, scope: SCOPE });
        const { scope, budgets, ...rest } = pass;
        return json({ ...rest, scopes: ['notes:read'], limits: {} }, 201);
      },
    });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const pass = await lane.pass();
    assert.deepEqual([...pass.scope].sort(), [...SCOPE].sort());
    assert.deepEqual(pass.budgets, []);
  });
});

describe('createAgentLaneClient: errors and retries', () => {
  test('after HTTP 403 it gets a new pass and sends the request again 1 time', async () => {
    const site = fakeSite({ lane: () => json({ error: 'The proof is not valid.', code: 'proof' }, 403) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const body = JSON.stringify({ text: 'hello' });

    const response = await lane.fetch('/api/notes', { method: 'POST', body });
    assert.equal(response.status, 403);
    assert.equal(site.passCalls.length, 2);
    assert.equal(site.laneCalls.length, 2, 'the client sends the request again only 1 time');
    assert.equal(site.laneCalls[0].headers.get('X-Agent-Session'), site.passes[0].reference);
    assert.equal(site.laneCalls[1].headers.get('X-Agent-Session'), site.passes[1].reference);
    assert.equal(site.laneCalls[1].init.body, body);
  });

  test('a retry that succeeds returns the second response', async () => {
    const site = fakeSite({ lane: (_call, count) => (count === 1 ? json({ code: 'pass' }, 403) : json({ ok: 2 })) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const response = await lane.fetch('/api/notes');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: 2 });
  });

  test('2 requests that fail at the same time cause only 1 new pass', async () => {
    const site = fakeSite({ lane: (_call, count) => (count <= 2 ? json({ code: 'pass' }, 403) : json({ ok: true })) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await lane.pass();
    const responses = await Promise.all([lane.fetch('/api/notes'), lane.fetch('/api/notes')]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(site.passCalls.length, 2);
  });

  test('after HTTP 401 it returns the response and does not get a new pass', async () => {
    const site = fakeSite({
      lane: () => json({ error: 'Sign in to the site to use the agent lane.', code: 'session' }, 401),
    });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const response = await lane.fetch('/api/notes');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'session');
    assert.equal(site.passCalls.length, 1);
    assert.equal(site.laneCalls.length, 1);
  });

  test('if the pass request fails, the error goes to the caller', async () => {
    const site = fakeSite({
      passAnswer: () => json({ error: 'Sign in to the site to use the agent lane.', code: 'session' }, 401),
    });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await assert.rejects(lane.fetch('/api/notes'), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'session');
      assert.match(error.message, /^agentlane: the site did not give a pass \(HTTP 401\)\. Sign in/);
      return true;
    });
    assert.equal(site.laneCalls.length, 0);
  });

  test('does not send the request again after HTTP 403 from the site handler', async () => {
    const answers = [
      () => json({ error: 'You cannot change this note.' }, 403),
      () => json({ error: 'Not your note.', code: 'forbidden' }, 403),
      () => new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } }),
    ];
    for (const answer of answers) {
      const site = fakeSite({ lane: answer });
      const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
      const response = await lane.fetch('/api/notes', { method: 'POST', body: '{"text":"x"}' });
      assert.equal(response.status, 403);
      assert.equal(site.laneCalls.length, 1, 'a write that reached the site handler is not sent again');
      assert.equal(site.passCalls.length, 1);
      assert.ok((await response.text()).length > 0, 'the caller can still read the body');
    }
  });

  test('does not send the request again after HTTP 403 with the code scope or lane-headers', async () => {
    for (const code of ['scope', 'lane-headers']) {
      const site = fakeSite({ lane: () => json({ error: 'No.', code }, 403) });
      const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
      const response = await lane.fetch('/api/notes');
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, code);
      assert.equal(site.laneCalls.length, 1);
    }
  });

  test('does not send a stream body again', async () => {
    const site = fakeSite({ lane: () => json({ code: 'proof' }, 403) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const response = await lane.fetch('/api/notes', { method: 'POST', body, duplex: 'half' });
    assert.equal(response.status, 403);
    assert.equal(site.laneCalls.length, 1);
  });

  test('does not send the request again after HTTP 429', async () => {
    const site = fakeSite({ lane: () => json({ code: 'budget', retryAfter: 7 }, 429, { 'Retry-After': '7' }) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const response = await lane.fetch('/api/notes');
    assert.equal(response.status, 429);
    assert.equal(site.laneCalls.length, 1);
    assert.equal(site.passCalls.length, 1);
  });

  test('a pass request with HTTP 429 gives an error with retryAfter', async () => {
    const site = fakeSite({
      passAnswer: () =>
        json({ error: 'The budget "agentlane.pass" has no room now.', code: 'budget', retryAfter: 12 }, 429, {
          'Retry-After': '12',
        }),
    });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await assert.rejects(lane.fetch('/api/notes'), { status: 429, code: 'budget', retryAfter: 12 });
    assert.equal(site.laneCalls.length, 0);
  });

  test('a pass that is not valid gives an error', async () => {
    const answers = [
      json({ reference: 'not-hex', expiresAt: T0, proofs: {} }, 201),
      json({ reference: 'a'.repeat(64), expiresAt: 'soon', proofs: {} }, 201),
      json({ reference: 'a'.repeat(64), expiresAt: T0, proofs: { 'GET /api/notes': 'bad' } }, 201),
      new Response('<html>blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ];
    for (const answer of answers) {
      const site = fakeSite({ passAnswer: () => answer });
      const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
      await assert.rejects(lane.fetch('/api/notes'), { message: 'agentlane: the pass from the site is not valid.' });
    }
  });

  test('a failed pass request does not block the next one', async () => {
    const site = fakeSite({ passAnswer: (_call, count) => (count === 1 ? json({ error: 'Down.' }, 503) : null) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await assert.rejects(lane.fetch('/api/notes'), { status: 503 });
    const response = await lane.fetch('/api/notes');
    assert.equal(response.status, 200);
    assert.equal(site.passCalls.length, 2);
  });

  test('an aborted signal stops the request before the pass request', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(lane.fetch('/api/notes', { signal: controller.signal }), { message: 'stop' });
    assert.equal(site.calls.length, 0);
  });

  test('a signal that aborts during the pass request stops the wait', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const site = fakeSite({ passAnswer: async () => void (await gate) });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const controller = new AbortController();
    const request = lane.fetch('/api/notes', { signal: controller.signal });
    controller.abort(new Error('the tool call was cancelled'));
    await assert.rejects(request, { message: 'the tool call was cancelled' });
    release();
    assert.equal(site.laneCalls.length, 0);
    // The pass request still completes and the client keeps the pass.
    await lane.pass();
    assert.equal(site.passCalls.length, 1);
  });
});

describe('createAgentLaneClient: page rules', () => {
  test('in a page, it sends requests only to the origin of the page', async (t) => {
    setGlobals(t, {
      location: { href: 'https://notes.example/app/', origin: 'https://notes.example' },
      document: { baseURI: 'https://notes.example/app/' },
    });
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });

    await lane.fetch('/api/notes?x=1');
    assert.equal(site.passCalls[0].url, 'https://notes.example/agentlane/pass');
    assert.equal(site.laneCalls[0].url, 'https://notes.example/api/notes?x=1');

    await lane.fetch('https://notes.example/api/notes');
    await lane.fetch(new URL('https://notes.example/api/notes'));
    assert.equal(site.laneCalls.length, 3);

    await assert.rejects(lane.fetch('https://other.example/api/notes'), /only to the origin of the page/);
    await assert.rejects(lane.fetch('//other.example/api/notes'), /only to the origin of the page/);
    assert.equal(site.laneCalls.length, 3);
  });

  test('in a page, a relative path uses the base URL of the document', async (t) => {
    setGlobals(t, {
      location: { href: 'https://notes.example/app/index.html', origin: 'https://notes.example' },
      document: { baseURI: 'https://notes.example/app/index.html' },
    });
    const site = fakeSite({ scope: ['GET /app/api/notes'] });
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await lane.fetch('api/notes');
    assert.equal(site.laneCalls[0].url, 'https://notes.example/app/api/notes');
    assert.equal(site.laneCalls[0].headers.get('X-Agent-Proof'), site.passes[0].proofs['GET /app/api/notes']);
  });

  test('a pass URL on another origin is refused', (t) => {
    setGlobals(t, { location: { href: 'https://notes.example/', origin: 'https://notes.example' } });
    assert.throws(() => createAgentLaneClient({ passUrl: 'https://other.example/agentlane/pass' }), /origin of the page/);
  });

  test('without a page, the path must start with "/"', async () => {
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await assert.rejects(lane.fetch('https://notes.example/api/notes'), /must start with "\/"/);
    await assert.rejects(lane.fetch('api/notes'), /must start with "\/"/);
    await assert.rejects(lane.fetch(42), TypeError);
  });

  test('keeps the pass in memory only', async (t) => {
    const writes = [];
    const storage = {
      setItem: (key) => writes.push(`storage:${key}`),
      getItem: () => null,
      removeItem: () => {},
    };
    const doc = { baseURI: 'https://notes.example/' };
    Object.defineProperty(doc, 'cookie', {
      get: () => '',
      set: (value) => writes.push(`cookie:${value}`),
    });
    setGlobals(t, {
      location: { href: 'https://notes.example/', origin: 'https://notes.example' },
      document: doc,
      localStorage: storage,
      sessionStorage: storage,
    });
    const site = fakeSite();
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    await lane.fetch('/api/notes');
    await lane.fetch('/api/notes', { method: 'POST', body: '{}' });
    assert.deepEqual(writes, []);
  });

  test('checks the options', () => {
    assert.throws(() => createAgentLaneClient({ fetchImpl: 'fetch' }), TypeError);
    assert.throws(() => createAgentLaneClient({ refreshMarginMs: -1 }), TypeError);
    assert.throws(() => createAgentLaneClient({ passUrl: '' }), TypeError);
    assert.throws(() => createAgentLaneClient({ headers: { reference: 'Bad Header' } }), TypeError);
    assert.throws(() => createAgentLaneClient({ headers: { reference: 'X-A', proof: 'x-a' } }), TypeError);
    assert.throws(() => createAgentLaneClient(null), TypeError);
  });
});

describe('createAgentLaneClient with the Worker adapter', () => {
  // The client talks to withAgentLane directly. The Worker uses the
  // recommended "writes" budget: 1 request in 1 day for each session.
  function laneSite(handler) {
    const origin = 'https://notes.example';
    const handlerCalls = [];
    const worker = withAgentLane(
      async (request) => {
        handlerCalls.push(`${request.method} ${new URL(request.url).pathname}`);
        return handler(request);
      },
      {
        secret: () => SECRET,
        session: async (request) => (request.headers.get('Cookie') === 'sid=dana' ? 'session-dana' : null),
        scope: ['POST /api/reservations', 'GET /api/reservations'],
        budgets: [{ name: 'writes', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 86400, per: 'session' }],
        store: memoryStores(),
        onAgentRequest: () => {},
      },
    );
    // The browser adds the cookie and the Origin header.
    const fetchImpl = (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Cookie', 'sid=dana');
      headers.set('Origin', origin);
      return worker.fetch(new Request(origin + url, { ...init, headers }), {}, undefined);
    };
    return { fetchImpl, handlerCalls };
  }

  test('a write that the site handler rejects reaches the handler 1 time, and the agent gets its response', async () => {
    const site = laneSite(() => json({ error: 'The restaurant is closed on this date.' }, 403));
    const lane = createAgentLaneClient({ fetchImpl: site.fetchImpl });
    const response = await lane.fetch('/api/reservations', { method: 'POST', body: '{"x":1}' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'The restaurant is closed on this date.' });
    assert.deepEqual(site.handlerCalls, ['POST /api/reservations']);
  });

  test('if the server does not know the pass, the client gets 1 new pass and sends the request again', async () => {
    // 2 Workers with the same secret and different stores. The client gets
    // its first pass from Worker A, then sends its tool request to Worker B.
    const siteA = laneSite(() => json({ ok: 'a' }));
    const siteB = laneSite(() => json({ ok: 'b' }));
    let target = siteA;
    const lane = createAgentLaneClient({ fetchImpl: (url, init) => target.fetchImpl(url, init) });
    const first = await lane.pass();
    target = siteB;
    const response = await lane.fetch('/api/reservations');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: 'b' });
    assert.notEqual((await lane.pass()).reference, first.reference);
    assert.deepEqual(siteB.handlerCalls, ['GET /api/reservations'], 'the handler runs 1 time');
    assert.deepEqual(siteA.handlerCalls, []);
  });
});
