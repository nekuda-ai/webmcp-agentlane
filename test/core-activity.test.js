import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityEvent, logLine } from '../src/core/activity.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { newReference } from '../src/core/pass.js';

const SESSION = 'session-key-of-person-a';

test('activityEvent returns the event fields and only the first 8 characters of the reference', () => {
  const reference = newReference();
  const event = activityEvent({
    at: 1_790_000_000_000,
    sessionKey: SESSION,
    reference,
    action: 'POST /api/reservations',
    status: 201,
  });
  assert.deepEqual(event, {
    at: 1_790_000_000_000,
    lane: 'agent',
    action: 'POST /api/reservations',
    status: 201,
    code: null,
    pass: reference.slice(0, 8),
  });
});

test('an activity event never holds the full reference or the session key', () => {
  for (const code of [undefined, 'lane-headers', 'scope', 'proof', 'session', 'pass', 'budget']) {
    const reference = newReference();
    const event = activityEvent({ sessionKey: SESSION, reference, action: 'GET /api/restaurants', status: 403, code });
    const text = JSON.stringify(event);
    assert.equal(text.includes(reference), false);
    assert.equal(text.includes(reference.slice(0, 9)), false);
    assert.equal(text.includes(SESSION), false);
    assert.equal(logLine(event).includes(reference), false);
    assert.equal(event.code, code ?? null);
  }
});

test('activityEvent keeps bad input out of the event', () => {
  const event = activityEvent({
    reference: 'X'.repeat(64),
    action: `GET /${'a'.repeat(1000)}`,
    status: '200',
    code: 'Not A Code With Spaces',
  });
  assert.equal(event.pass, null);
  assert.equal(event.action.length, 200);
  assert.equal(event.status, null);
  assert.equal(event.code, null);
  assert.equal(typeof event.at, 'number');
  assert.equal(activityEvent({ reference: 42 }).pass, null);
  assert.equal(activityEvent().lane, 'agent');
});

test('logLine returns 1 line of JSON with only the event fields', () => {
  const reference = newReference();
  const event = activityEvent({ at: 1, reference, action: 'GET /api/restaurants', status: 429, code: 'budget' });
  const line = logLine(event);
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), {
    type: 'agentlane.activity',
    at: 1,
    lane: 'agent',
    action: 'GET /api/restaurants',
    status: 429,
    code: 'budget',
    pass: reference.slice(0, 8),
  });
});

test('logLine drops extra fields, also when a caller adds the reference', () => {
  const reference = newReference();
  const event = { ...activityEvent({ reference, action: 'GET /api/x', status: 200 }), reference, sessionKey: SESSION, proof: 'secret-proof', pass: reference };
  const line = logLine(event);
  assert.equal(line.includes(reference), false);
  assert.equal(line.includes(SESSION), false);
  assert.equal(line.includes('secret-proof'), false);
  assert.equal(JSON.parse(line).pass, reference.slice(0, 8));
  assert.doesNotThrow(() => JSON.parse(logLine(undefined)));
});

test('events in the store never hold the full reference', async () => {
  const store = new MemoryStore();
  const reference = newReference();
  const owner = { sessionKey: SESSION };
  await store.logActivity(activityEvent({ sessionKey: SESSION, reference, action: 'GET /api/restaurants', status: 200 }), owner);
  await store.logActivity(activityEvent({ sessionKey: SESSION, reference, action: 'POST /api/reservations', status: 429, code: 'budget' }), owner);
  const events = await store.listActivity({ sessionKey: SESSION, limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(JSON.stringify(events).includes(reference), false);
  assert.equal(events[0].action, 'POST /api/reservations');
});
