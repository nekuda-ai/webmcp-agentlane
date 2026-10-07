// The core, the Worker adapter, the WAF rules and the lane client each
// have their own copy of some defaults. These tests check that the copies agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core/index.js';
import * as worker from '../src/cloudflare/worker.js';
import * as waf from '../src/cloudflare/waf.js';
import * as browser from '../src/browser/agentlane.js';

test('the lane header names are the same in all modules', () => {
  const expected = { reference: 'X-Agent-Session', proof: 'X-Agent-Proof' };
  assert.deepEqual({ ...worker.DEFAULT_HEADERS }, expected);
  assert.deepEqual({ ...waf.DEFAULT_HEADERS }, expected);
  assert.deepEqual({ ...browser.DEFAULT_HEADERS }, expected);
});

test('the lane client accepts what issuePass makes', async () => {
  const pass = await core.issuePass({
    secret: 'test-secret-0123456789abcdef0123456789abcdef',
    scope: ['GET /api/items', 'POST /api/orders'],
  });
  const client = browser.createAgentLaneClient({
    fetchImpl: async () =>
      new Response(JSON.stringify(pass), { status: 201, headers: { 'Content-Type': 'application/json' } }),
  });
  const received = await client.pass();
  assert.equal(received.reference, pass.reference);
  assert.deepEqual(received.scope, pass.scope);
  assert.deepEqual({ ...received.proofs }, pass.proofs);
});

test('the default pass path is the same in the Worker and the lane client', async () => {
  const seen = [];
  const client = browser.createAgentLaneClient({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await assert.rejects(client.pass());
  assert.deepEqual(seen, ['/agentlane/pass']);

  const lane = worker.withAgentLane(async () => new Response('site'), {
    secret: () => 'test-secret-0123456789abcdef0123456789abcdef',
    session: async () => 'session-1',
    scope: ['GET /api/items'],
    store: core.memoryStores(),
    onAgentRequest: () => {},
  });
  const origin = 'https://shop.example';
  const response = await lane.fetch(
    new Request(`${origin}/agentlane/pass`, { method: 'POST', headers: { Origin: origin } }),
    {},
    undefined,
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  // The default TTL is 900 seconds in the core and in the Worker.
  const issuedAt = Number(body.proofs['GET /api/items'].slice(0, 10));
  assert.equal(body.expiresAt, (issuedAt + core.DEFAULT_TTL_SECONDS) * 1000);
  assert.equal(core.DEFAULT_TTL_SECONDS, 900);
});

test('the default WAF TTL is the same as the core TTL', () => {
  const rules = waf.wafRules({ host: 'example.com', secret: 'test', scope: ['GET /api/items'] });
  assert.match(rules.skipBotFilterForValid[0].expression, new RegExp(`, ${core.DEFAULT_TTL_SECONDS}, http\\.request\\.timestamp\\.sec, 8\\)`));
});
