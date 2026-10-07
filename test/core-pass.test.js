import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { hashReference, issuePass, newReference } from '../src/core/pass.js';
import { PROOF_PATTERN, REFERENCE_PATTERN, verifyProof } from '../src/core/proof.js';

// A test secret. It is not used anywhere outside the tests.
const SECRET = 'agentlane-test-secret-not-for-production';
const NOW_MS = 1_790_000_000_123;
const T = Math.floor(NOW_MS / 1000);
const SCOPE = ['GET /api/restaurants', 'GET /api/availability', 'GET /api/reservations', 'POST /api/reservations'];

test('newReference returns 64 lower-case hex characters, different each time', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const reference = newReference();
    assert.match(reference, REFERENCE_PATTERN);
    seen.add(reference);
  }
  assert.equal(seen.size, 200);
});

test('hashReference returns the SHA-256 hex digest', async () => {
  const reference = newReference();
  assert.equal(await hashReference(reference), createHash('sha256').update(reference).digest('hex'));
});

test('issuePass returns the pass response fields of the wire format', async () => {
  const pass = await issuePass({ secret: SECRET, scope: SCOPE, nowMs: NOW_MS });
  assert.deepEqual(Object.keys(pass).sort(), ['budgets', 'expiresAt', 'proofs', 'reference', 'scope']);
  assert.match(pass.reference, REFERENCE_PATTERN);
  assert.equal(pass.expiresAt, (T + 900) * 1000);
  assert.deepEqual(pass.scope, SCOPE);
  assert.deepEqual(Object.keys(pass.proofs), SCOPE);
  assert.deepEqual(pass.budgets, []);
  // The response is plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(pass)), pass);
});

test('issuePass signs 1 proof for each action, compatible with tableforagents.com', async () => {
  const pass = await issuePass({ secret: SECRET, scope: SCOPE, nowMs: NOW_MS });
  for (const action of SCOPE) {
    const [method, path] = action.split(' ');
    const proof = pass.proofs[action];
    assert.match(proof, PROOF_PATTERN);
    assert.equal(proof.split('-')[0], String(T));
    const mac = createHmac('sha256', SECRET).update(`${pass.reference}:${method}:${path}${T}`).digest('base64');
    assert.equal(proof, `${T}-${encodeURIComponent(mac)}`);
    assert.deepEqual(await verifyProof(SECRET, pass.reference, method, path, proof, { nowSeconds: T + 899 }), { ok: true });
  }
  // A proof is valid only for its own action.
  const [method, path] = SCOPE[0].split(' ');
  const wrong = await verifyProof(SECRET, pass.reference, method, path, pass.proofs[SCOPE[3]], { nowSeconds: T });
  assert.equal(wrong.ok, false);
});

test('issuePass uses ttlSeconds for expiresAt', async () => {
  const pass = await issuePass({ secret: SECRET, scope: SCOPE, nowMs: NOW_MS, ttlSeconds: 60 });
  assert.equal(pass.expiresAt, (T + 60) * 1000);
});

test('issuePass normalizes the scope and the budgets', async () => {
  const pass = await issuePass({
    secret: SECRET,
    scope: ['post /api/reservations', 'GET /api/restaurants', 'POST /api/reservations'],
    nowMs: NOW_MS,
    budgets: [
      { name: 'bookings', actions: ['post /api/reservations'], limit: 1, windowSeconds: 86400, per: 'session' },
      { name: 'all-tools', actions: '*', limit: 30, windowSeconds: 60 },
    ],
  });
  assert.deepEqual(pass.scope, ['POST /api/reservations', 'GET /api/restaurants']);
  assert.deepEqual(Object.keys(pass.proofs), pass.scope);
  assert.deepEqual(pass.budgets, [
    { name: 'bookings', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 86400, per: 'session' },
    { name: 'all-tools', actions: '*', limit: 30, windowSeconds: 60, per: 'session' },
  ]);
});

test('issuePass gives a new reference each time', async () => {
  const a = await issuePass({ secret: SECRET, scope: SCOPE, nowMs: NOW_MS });
  const b = await issuePass({ secret: SECRET, scope: SCOPE, nowMs: NOW_MS });
  assert.notEqual(a.reference, b.reference);
  assert.notEqual(a.proofs[SCOPE[0]], b.proofs[SCOPE[0]]);
});

test('issuePass throws TypeError for a configuration that is not valid', async () => {
  await assert.rejects(issuePass({ secret: SECRET, scope: [] }), TypeError);
  await assert.rejects(issuePass({ secret: SECRET, scope: ['GET /api/x?y=1'] }), TypeError);
  await assert.rejects(issuePass({ secret: '', scope: SCOPE }), TypeError);
  await assert.rejects(issuePass({ secret: SECRET, scope: SCOPE, ttlSeconds: 0 }), TypeError);
  await assert.rejects(issuePass({ secret: SECRET, scope: SCOPE, nowMs: 'now' }), TypeError);
  await assert.rejects(issuePass(), TypeError);
  // A budget must cover only actions in the scope. A typing error must not hide a budget.
  await assert.rejects(
    issuePass({
      secret: SECRET,
      scope: SCOPE,
      budgets: [{ name: 'bookings', actions: ['POST /api/reservation'], limit: 1, windowSeconds: 60 }],
    }),
    /not in the scope/,
  );
});
