import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { PROOF_PATTERN, REFERENCE_PATTERN, signProof, verifyProof } from '../src/core/proof.js';

// A test secret. It is not used anywhere outside the tests.
const SECRET = 'agentlane-test-secret-not-for-production';
const REFERENCE = '0123456789abcdef'.repeat(4);
const T = 1_790_000_000;
const ACTIONS = [
  ['GET', '/api/restaurants'],
  ['GET', '/api/availability'],
  ['GET', '/api/reservations'],
  ['POST', '/api/reservations'],
];

// The proof as tableforagents.com computes it, but with node:crypto.
function nodeProof(secret, reference, method, path, timestamp) {
  const mac = createHmac('sha256', secret).update(`${reference}:${method}:${path}${timestamp}`).digest('base64');
  return `${timestamp}-${encodeURIComponent(mac)}`;
}

// A copy of the live functions in tableforagents.com src/app.js
// (agentMessage, agentProofs, verifyAgentProof), with the secret as a parameter.
const encoder = new TextEncoder();
const liveKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const liveMessage = (reference, method, path, timestamp) => encoder.encode(`${reference}:${method}:${path}${timestamp}`);
async function liveSign(secret, reference, method, path, timestamp) {
  const signature = await crypto.subtle.sign('HMAC', await liveKey(secret), liveMessage(reference, method, path, timestamp));
  return `${timestamp}-${encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(signature))))}`;
}
async function liveVerify(secret, reference, method, path, header, current) {
  const proof = /^(\d{10})-((?:[A-Za-z0-9]|%2B|%2F){43}%3D)$/.exec(header || '');
  const timestamp = Number(proof?.[1]);
  if (!proof || timestamp > current || timestamp + 900 <= current) return false;
  const signature = Uint8Array.from(atob(decodeURIComponent(proof[2])), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await liveKey(secret), signature, liveMessage(reference, method, path, timestamp));
}

// A model of the Cloudflare check is_timed_hmac_valid_v0 with a separator length of 8.
// The edge input is concat(reference, ":METHOD:", path, "?verify=", proof).
function edgeCheck(secret, messageMac, ttl, nowSeconds, separatorLength) {
  const match = /^(.*)(\d{10})-([^-]+)$/s.exec(messageMac);
  if (!match) return false;
  const message = match[1].slice(0, match[1].length - separatorLength);
  const timestamp = Number(match[2]);
  if (timestamp > nowSeconds || timestamp + ttl <= nowSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${message}${timestamp}`).digest('base64');
  return decodeURIComponent(match[3]) === expected;
}

test('COMPATIBILITY: signProof gives the same string as node:crypto with the tableforagents message format', async () => {
  for (const [method, path] of ACTIONS) {
    for (let i = 0; i < 25; i += 1) {
      const reference = randomBytes(32).toString('hex');
      const timestamp = T + i * 37;
      const expected = nodeProof(SECRET, reference, method, path, timestamp);
      const actual = await signProof(SECRET, reference, method, path, timestamp);
      assert.equal(actual, expected);
      assert.match(actual, PROOF_PATTERN);
      assert.deepEqual(
        await verifyProof(SECRET, reference, method, path, expected, { nowSeconds: timestamp }),
        { ok: true },
      );
    }
  }
});

test('COMPATIBILITY: fixed vectors from node:crypto createHmac', async () => {
  const vectors = [
    ['POST', '/api/reservations', '1790000000-fpP2Xg3HR3XXwz9kUJpEWXBsU2vUArGBbMdeUJuBaIE%3D'],
    ['GET', '/api/restaurants', '1790000000-CJgL1AMDhU8Z167dQxRZ6oM1zPJTqsmI2wD4rkql6ao%3D'],
  ];
  for (const [method, path, proof] of vectors) {
    assert.equal(nodeProof(SECRET, REFERENCE, method, path, T), proof);
    assert.equal(await signProof(SECRET, REFERENCE, method, path, T), proof);
    assert.deepEqual(await verifyProof(SECRET, REFERENCE, method, path, proof, { nowSeconds: T + 10 }), { ok: true });
  }
});

test('COMPATIBILITY: the live tableforagents code and the core accept the proofs of each other', async () => {
  for (const [method, path] of ACTIONS) {
    const reference = randomBytes(32).toString('hex');
    const live = await liveSign(SECRET, reference, method, path, T);
    const core = await signProof(SECRET, reference, method, path, T);
    assert.equal(core, live);
    assert.equal(await liveVerify(SECRET, reference, method, path, core, T + 5), true);
    assert.deepEqual(await verifyProof(SECRET, reference, method, path, live, { nowSeconds: T + 5 }), { ok: true });
  }
});

test('COMPATIBILITY: the edge message format accepts the proof', async () => {
  for (const [method, path] of ACTIONS) {
    const reference = randomBytes(32).toString('hex');
    const proof = await signProof(SECRET, reference, method, path, T);
    const edgeInput = `${reference}:${method}:${path}?verify=${proof}`;
    assert.equal(edgeCheck(SECRET, edgeInput, 900, T + 1, 8), true);
    assert.equal(edgeCheck(SECRET, edgeInput, 900, T + 900, 8), false);
    assert.equal(edgeCheck('another-secret', edgeInput, 900, T + 1, 8), false);
  }
});

test('the proof always matches PROOF_PATTERN, also when the MAC has "+" or "/"', async () => {
  let encodedSpecial = 0;
  for (let i = 0; i < 300; i += 1) {
    const proof = await signProof(SECRET, randomBytes(32).toString('hex'), 'POST', '/api/reservations', T);
    assert.match(proof, PROOF_PATTERN);
    if (/%2B|%2F/.test(proof)) encodedSpecial += 1;
  }
  assert.ok(encodedSpecial > 0, 'expected some MACs with "+" or "/"');
});

test('REFERENCE_PATTERN accepts only 64 lower-case hex characters', () => {
  assert.equal(REFERENCE_PATTERN.test(REFERENCE), true);
  assert.equal(REFERENCE_PATTERN.test(REFERENCE.toUpperCase()), false);
  assert.equal(REFERENCE_PATTERN.test(REFERENCE.slice(1)), false);
  assert.equal(REFERENCE_PATTERN.test(`${REFERENCE}0`), false);
});

test('expiry: the proof is valid from its timestamp until timestamp + ttl', async () => {
  const proof = await signProof(SECRET, REFERENCE, 'POST', '/api/reservations', T);
  const at = (nowSeconds, ttlSeconds) =>
    verifyProof(SECRET, REFERENCE, 'POST', '/api/reservations', proof, { nowSeconds, ttlSeconds });
  assert.deepEqual(await at(T), { ok: true });
  assert.deepEqual(await at(T + 899), { ok: true });
  assert.deepEqual(await at(T + 900), { ok: false, code: 'proof', reason: 'expired' });
  assert.deepEqual(await at(T + 100_000), { ok: false, code: 'proof', reason: 'expired' });
  assert.deepEqual(await at(T + 59, 60), { ok: true });
  assert.deepEqual(await at(T + 60, 60), { ok: false, code: 'proof', reason: 'expired' });
});

test('future: a proof with a timestamp after now is not valid', async () => {
  const proof = await signProof(SECRET, REFERENCE, 'GET', '/api/restaurants', T);
  assert.deepEqual(
    await verifyProof(SECRET, REFERENCE, 'GET', '/api/restaurants', proof, { nowSeconds: T - 1 }),
    { ok: false, code: 'proof', reason: 'future' },
  );
});

test('the default time is the current time', async () => {
  const now = Math.floor(Date.now() / 1000);
  const proof = await signProof(SECRET, REFERENCE, 'GET', '/api/restaurants');
  assert.equal(Number(proof.split('-')[0]) >= now, true);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, 'GET', '/api/restaurants', proof), { ok: true });
});

test('a tampered signature, reference, method, path, timestamp or secret fails', async () => {
  const method = 'POST';
  const path = '/api/reservations';
  const proof = await signProof(SECRET, REFERENCE, method, path, T);
  const options = { nowSeconds: T + 1 };
  const signatureFail = { ok: false, code: 'proof', reason: 'signature' };

  // Change the first character of the MAC.
  const mac = proof.slice(11);
  const tampered = `${T}-${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, method, path, tampered, options), signatureFail);

  const otherReference = `${REFERENCE.slice(0, 63)}${REFERENCE[63] === '0' ? '1' : '0'}`;
  assert.deepEqual(await verifyProof(SECRET, otherReference, method, path, proof, options), signatureFail);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, 'GET', path, proof, options), signatureFail);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, 'PUT', path, proof, options), signatureFail);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, method, '/api/reservation', proof, options), signatureFail);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, method, '/api/reservations/1', proof, options), signatureFail);
  assert.deepEqual(await verifyProof(SECRET, REFERENCE, method, path, `${T - 1}${proof.slice(10)}`, options), signatureFail);
  assert.deepEqual(await verifyProof('another-secret', REFERENCE, method, path, proof, options), signatureFail);
});

test('format: bad references and bad proofs fail without an exception', async () => {
  const proof = await signProof(SECRET, REFERENCE, 'POST', '/api/reservations', T);
  const formatFail = { ok: false, code: 'proof', reason: 'format' };
  const check = (reference, value, method = 'POST', path = '/api/reservations') =>
    verifyProof(SECRET, reference, method, path, value, { nowSeconds: T + 1 });

  assert.deepEqual(await check(REFERENCE.toUpperCase(), proof), formatFail);
  assert.deepEqual(await check(REFERENCE.slice(1), proof), formatFail);
  assert.deepEqual(await check(undefined, proof), formatFail);
  assert.deepEqual(await check(REFERENCE, undefined), formatFail);
  assert.deepEqual(await check(REFERENCE, ''), formatFail);
  assert.deepEqual(await check(REFERENCE, proof.replace('%3D', '=')), formatFail);
  assert.deepEqual(await check(REFERENCE, `${proof} `), formatFail);
  assert.deepEqual(await check(REFERENCE, proof.slice(1)), formatFail);
  assert.deepEqual(await check(REFERENCE, decodeURIComponent(proof)), formatFail);
  assert.deepEqual(await check(REFERENCE, proof, 'POST', 'api/reservations'), formatFail);
  assert.deepEqual(await check(REFERENCE, proof, 'P0ST', '/api/reservations'), formatFail);
  assert.deepEqual(await check(REFERENCE, proof, 42, '/api/reservations'), formatFail);
});

test('format: a MAC in a form that is not canonical fails', async () => {
  // 32 bytes need 43 base64 characters and "=". The last character carries 2 unused bits.
  const proof = await signProof(SECRET, REFERENCE, 'POST', '/api/reservations', T);
  const encoded = decodeURIComponent(proof.slice(11));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(encoded[42]);
  const sibling = `${encoded.slice(0, 42)}${alphabet[last ^ 1]}=`;
  assert.deepEqual(Uint8Array.from(atob(sibling), (c) => c.charCodeAt(0)), Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  assert.deepEqual(
    await verifyProof(SECRET, REFERENCE, 'POST', '/api/reservations', `${T}-${encodeURIComponent(sibling)}`, { nowSeconds: T + 1 }),
    { ok: false, code: 'proof', reason: 'format' },
  );
});

test('the method becomes upper-case and the query string is removed', async () => {
  const upper = await signProof(SECRET, REFERENCE, 'POST', '/api/reservations', T);
  assert.equal(await signProof(SECRET, REFERENCE, 'post', '/api/reservations', T), upper);
  assert.equal(await signProof(SECRET, REFERENCE, 'POST', '/api/reservations?date=2026-10-07', T), upper);
  assert.deepEqual(
    await verifyProof(SECRET, REFERENCE, 'post', '/api/reservations?x=1', upper, { nowSeconds: T }),
    { ok: true },
  );
});

test('the secret can be a string, bytes or a CryptoKey', async () => {
  const expected = await signProof(SECRET, REFERENCE, 'GET', '/api/restaurants', T);
  const bytes = new TextEncoder().encode(SECRET);
  assert.equal(await signProof(bytes, REFERENCE, 'GET', '/api/restaurants', T), expected);
  assert.equal(await signProof(bytes.buffer, REFERENCE, 'GET', '/api/restaurants', T), expected);
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  assert.equal(await signProof(key, REFERENCE, 'GET', '/api/restaurants', T), expected);
  assert.deepEqual(await verifyProof(key, REFERENCE, 'GET', '/api/restaurants', expected, { nowSeconds: T }), { ok: true });
});

test('configuration errors throw TypeError', async () => {
  await assert.rejects(signProof('', REFERENCE, 'GET', '/api/x', T), TypeError);
  await assert.rejects(signProof(undefined, REFERENCE, 'GET', '/api/x', T), TypeError);
  await assert.rejects(signProof(SECRET, 'not-a-reference', 'GET', '/api/x', T), TypeError);
  await assert.rejects(signProof(SECRET, REFERENCE, 'GET', 'api/x', T), TypeError);
  await assert.rejects(signProof(SECRET, REFERENCE, 'GET', '/api/x', 999_999_999), TypeError);
  await assert.rejects(signProof(SECRET, REFERENCE, 'GET', '/api/x', T + 0.5), TypeError);
  await assert.rejects(signProof(SECRET, REFERENCE, 'GET', '/api/x', T * 1000), TypeError);
  await assert.rejects(verifyProof('', REFERENCE, 'GET', '/api/x', 'x'), TypeError);
  await assert.rejects(verifyProof(SECRET, REFERENCE, 'GET', '/api/x', 'x', { ttlSeconds: 0 }), TypeError);
  await assert.rejects(verifyProof(SECRET, REFERENCE, 'GET', '/api/x', 'x', { ttlSeconds: 900_000 }), TypeError);
  await assert.rejects(verifyProof(SECRET, REFERENCE, 'GET', '/api/x', 'x', { nowSeconds: 'now' }), TypeError);
});
