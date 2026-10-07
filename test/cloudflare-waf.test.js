// Tests for the WAF rule generator (src/cloudflare/waf.js).
// The secret in these tests is a placeholder. Never put a real secret here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wafRules, orderedRules, MAX_EXPRESSION_LENGTH } from '../src/cloudflare/waf.js';
import { newReference, signProof } from '../src/core/index.js';

const SECRET = '<AGENTLANE_SECRET>';
const TABLE_SCOPE = [
  'GET /api/restaurants',
  'GET /api/availability',
  'GET /api/reservations',
  'POST /api/reservations',
];

// The live rules on tableforagents.com, with the secret replaced by the placeholder.
const LIVE = {
  rejectWrites: String.raw`http.host eq "tableforagents.com" and (has_key(http.request.headers, "x-agent-session") or has_key(http.request.headers, "x-agent-proof")) and http.request.method ne "GET" and not (coalesce(len(http.request.headers["x-agent-session"]), 0) eq 1 and coalesce(len(http.request.headers["x-agent-proof"]), 0) eq 1 and len(coalesce(http.request.headers["x-agent-session"][0], "")) eq 64 and http.request.method eq "POST" and http.request.uri.path eq "/api/reservations" and is_timed_hmac_valid_v0("<AGENTLANE_SECRET>", concat(coalesce(http.request.headers["x-agent-session"][0], ""), ":POST:", http.request.uri.path, "?verify=", coalesce(http.request.headers["x-agent-proof"][0], "")), 900, http.request.timestamp.sec, 8))`,
  rejectReads: String.raw`http.host eq "tableforagents.com" and (has_key(http.request.headers, "x-agent-session") or has_key(http.request.headers, "x-agent-proof")) and http.request.method eq "GET" and not (coalesce(len(http.request.headers["x-agent-session"]), 0) eq 1 and coalesce(len(http.request.headers["x-agent-proof"]), 0) eq 1 and len(coalesce(http.request.headers["x-agent-session"][0], "")) eq 64 and http.request.method eq "GET" and http.request.uri.path in {"/api/restaurants" "/api/availability" "/api/reservations"} and is_timed_hmac_valid_v0("<AGENTLANE_SECRET>", concat(coalesce(http.request.headers["x-agent-session"][0], ""), ":GET:", http.request.uri.path, "?verify=", coalesce(http.request.headers["x-agent-proof"][0], "")), 900, http.request.timestamp.sec, 8))`,
  skipReads: String.raw`http.host eq "tableforagents.com" and (coalesce(len(http.request.headers["x-agent-session"]), 0) eq 1 and coalesce(len(http.request.headers["x-agent-proof"]), 0) eq 1 and len(coalesce(http.request.headers["x-agent-session"][0], "")) eq 64 and http.request.method eq "GET" and http.request.uri.path in {"/api/restaurants" "/api/availability" "/api/reservations"} and is_timed_hmac_valid_v0("<AGENTLANE_SECRET>", concat(coalesce(http.request.headers["x-agent-session"][0], ""), ":GET:", http.request.uri.path, "?verify=", coalesce(http.request.headers["x-agent-proof"][0], "")), 900, http.request.timestamp.sec, 8))`,
  skipBookings: String.raw`http.host eq "tableforagents.com" and (coalesce(len(http.request.headers["x-agent-session"]), 0) eq 1 and coalesce(len(http.request.headers["x-agent-proof"]), 0) eq 1 and len(coalesce(http.request.headers["x-agent-session"][0], "")) eq 64 and http.request.method eq "POST" and http.request.uri.path eq "/api/reservations" and is_timed_hmac_valid_v0("<AGENTLANE_SECRET>", concat(coalesce(http.request.headers["x-agent-session"][0], ""), ":POST:", http.request.uri.path, "?verify=", coalesce(http.request.headers["x-agent-proof"][0], "")), 900, http.request.timestamp.sec, 8))`,
  skipPass: String.raw`http.host eq "tableforagents.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/agent-session" and any(http.request.headers["origin"][*] eq "https://tableforagents.com")`,
};

describe('wafRules for the tableforagents.com scope', () => {
  const rules = wafRules({
    host: 'tableforagents.com',
    secret: SECRET,
    scope: TABLE_SCOPE,
    origin: 'https://tableforagents.com',
    passPath: '/api/agent-session',
  });

  test('makes the same expressions as the live rules', () => {
    assert.deepEqual(
      rules.rejectInvalid.map((rule) => rule.expression),
      [LIVE.rejectWrites, LIVE.rejectReads],
    );
    assert.deepEqual(
      rules.skipBotFilterForValid.map((rule) => rule.expression),
      [LIVE.skipReads, LIVE.skipBookings],
    );
    assert.deepEqual(rules.skipBotFilterForPass.map((rule) => rule.expression), [LIVE.skipPass]);
  });

  test('blocks with HTTP 403 and a JSON error', () => {
    for (const rule of rules.rejectInvalid) {
      assert.equal(rule.action, 'block');
      assert.equal(rule.enabled, true);
      const { response } = rule.action_parameters;
      assert.equal(response.status_code, 403);
      assert.equal(response.content_type, 'application/json');
      const body = JSON.parse(response.content);
      assert.equal(body.code, 'proof');
      assert.equal(typeof body.error, 'string');
    }
  });

  test('skips only the Super Bot Fight Mode phase, with logging', () => {
    for (const rule of [...rules.skipBotFilterForValid, ...rules.skipBotFilterForPass]) {
      assert.equal(rule.action, 'skip');
      assert.deepEqual(rule.action_parameters, { phases: ['http_request_sbfm'] });
      assert.deepEqual(rule.logging, { enabled: true });
    }
  });

  test('has descriptions with the default label', () => {
    assert.deepEqual(
      orderedRules(rules).map((rule) => rule.description),
      [
        'Agent lane - reject invalid agent writes',
        'Agent lane - reject invalid agent reads',
        'Agent lane - signed agent GET requests',
        'Agent lane - signed agent POST requests',
        'Agent lane - pass request',
      ],
    );
  });

  test('puts the block rules first', () => {
    const actions = orderedRules(rules).map((rule) => rule.action);
    assert.deepEqual(actions, ['block', 'block', 'skip', 'skip', 'skip']);
  });
});

describe('wafRules for other scopes', () => {
  const base = { host: 'shop.example', secret: SECRET };

  test('combines more than 1 write method in the reject rule, with 1 skip rule for each', () => {
    const rules = wafRules({
      ...base,
      scope: ['POST /api/orders', 'GET /api/items', 'DELETE /api/orders', 'POST /api/carts', 'POST /api/orders'],
    });
    const writes = rules.rejectInvalid[0].expression;
    assert.match(writes, /and not \(\(coalesce.*"DELETE".*\) or \(coalesce.*"POST".*\)\)$/);
    assert.ok(writes.includes('http.request.uri.path in {"/api/orders" "/api/carts"}'), 'POST paths, no duplicate');
    assert.ok(writes.includes('http.request.uri.path eq "/api/orders"'), 'DELETE path');
    assert.deepEqual(
      rules.skipBotFilterForValid.map((rule) => rule.description),
      [
        'Agent lane - signed agent GET requests',
        'Agent lane - signed agent DELETE requests',
        'Agent lane - signed agent POST requests',
      ],
    );
    assert.ok(rules.skipBotFilterForValid[1].expression.includes('":DELETE:"'));
  });

  test('blocks all lane reads when the scope has no GET action', () => {
    const rules = wafRules({ ...base, scope: ['POST /api/orders'] });
    assert.equal(
      rules.rejectInvalid[1].expression,
      'http.host eq "shop.example" and (has_key(http.request.headers, "x-agent-session") or ' +
        'has_key(http.request.headers, "x-agent-proof")) and http.request.method eq "GET"',
    );
    assert.equal(rules.skipBotFilterForValid.length, 1);
  });

  test('blocks all lane writes when the scope has only GET actions', () => {
    const rules = wafRules({ ...base, scope: ['GET /api/items'] });
    assert.ok(rules.rejectInvalid[0].expression.endsWith('and http.request.method ne "GET"'));
    assert.equal(rules.skipBotFilterForValid.length, 1);
  });

  test('uses the TTL, the label and lower-case custom header names', () => {
    const rules = wafRules({
      ...base,
      scope: ['GET /api/items'],
      ttlSeconds: 300,
      label: 'Shop',
      headers: { reference: 'X-Lane-Ref', proof: 'X-Lane-Proof' },
    });
    const text = JSON.stringify(orderedRules(rules));
    assert.ok(text.includes('x-lane-ref') && text.includes('x-lane-proof'));
    assert.ok(!text.includes('x-agent-session'));
    assert.ok(rules.skipBotFilterForValid[0].expression.includes(', 300, http.request.timestamp.sec, 8)'));
    assert.equal(rules.rejectInvalid[0].description, 'Shop - reject invalid agent writes');
  });

  test('has no pass rule when origin is not set', () => {
    const rules = wafRules({ ...base, scope: ['GET /api/items'] });
    assert.deepEqual(Object.keys(rules), ['rejectInvalid', 'skipBotFilterForValid']);
  });
});

describe('wafRules input checks', () => {
  const base = { host: 'shop.example', secret: SECRET, scope: ['GET /api/items'] };
  const cases = [
    ['a host with a quote', { host: 'shop.example" or true or "' }],
    ['an upper-case host', { host: 'Shop.Example' }],
    ['a secret with a quote', { secret: 'abc"def' }],
    ['a secret with a backslash', { secret: 'abc\\def' }],
    ['a secret with a space', { secret: 'abc def' }],
    ['an empty secret', { secret: '' }],
    ['a path with a quote', { scope: ['GET /api/"items'] }],
    ['a path with a backslash', { scope: ['GET /api/\\items'] }],
    ['an empty scope', { scope: [] }],
    ['a bad TTL', { ttlSeconds: 1.5 }],
    ['a bad header name', { headers: { reference: 'X Agent' } }],
    ['the same header twice', { headers: { reference: 'X-A', proof: 'x-a' } }],
    ['an http origin', { origin: 'http://shop.example' }],
    ['a label with a quote', { label: 'a"b' }],
  ];
  for (const [name, change] of cases) {
    test(`rejects ${name}`, () => {
      assert.throws(() => wafRules({ ...base, ...change }), TypeError);
    });
  }

  test('never puts the secret in an error message', () => {
    const secret = 'real-looking-secret"0123456789abcdef';
    assert.throws(
      () => wafRules({ ...base, secret }),
      (error) => !error.message.includes(secret) && !error.message.includes('0123456789abcdef'),
    );
  });

  test('rejects a scope that makes an expression too long', () => {
    const scope = Array.from({ length: 200 }, (_, i) => `GET /api/items/number-${i}`);
    assert.throws(() => wafRules({ ...base, scope }), RangeError);
    assert.equal(MAX_EXPRESSION_LENGTH, 4096);
  });
});

// A model of the Cloudflare function is_timed_hmac_valid_v0.
// The input is <message><separator><timestamp>-<URL-encoded base64 MAC>.
// The MAC is HMAC-SHA256 over <message><timestamp>.
async function edgeCheck(secret, messageMac, ttl, nowSeconds, separatorLength) {
  const match = /^([\s\S]*)(\d{10})-([^-]+)$/.exec(messageMac);
  if (!match) return false;
  const message = match[1].slice(0, match[1].length - separatorLength);
  const timestamp = Number(match[2]);
  if (timestamp > nowSeconds || timestamp + ttl <= nowSeconds) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const mac = Uint8Array.from(atob(decodeURIComponent(match[3])), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${message}${timestamp}`));
}

describe('the edge message format', () => {
  test('a proof from core passes the model of the edge check', async () => {
    const secret = 'test-secret-0123456789abcdef0123456789abcdef';
    const reference = newReference();
    const now = 1_800_000_000;
    const proof = await signProof(secret, reference, 'POST', '/api/reservations', now);
    // The rule builds the message like this:
    // concat(reference, ":POST:", http.request.uri.path, "?verify=", proof)
    const message = (method, path, value = proof) => `${reference}:${method}:${path}?verify=${value}`;
    assert.equal(await edgeCheck(secret, message('POST', '/api/reservations'), 900, now + 10, 8), true);
    assert.equal(await edgeCheck(secret, message('GET', '/api/reservations'), 900, now + 10, 8), false);
    assert.equal(await edgeCheck(secret, message('POST', '/api/other'), 900, now + 10, 8), false);
    assert.equal(await edgeCheck(secret, message('POST', '/api/reservations'), 900, now + 900, 8), false);
    assert.equal(await edgeCheck('another-secret', message('POST', '/api/reservations'), 900, now, 8), false);
  });
});
