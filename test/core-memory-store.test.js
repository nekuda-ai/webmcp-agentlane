import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, createMemoryStore, memoryStores } from '../src/core/memory-store.js';
import { hashReference, newReference } from '../src/core/pass.js';

test('putPass and getPass keep the session key and the expiry time', async () => {
  const store = createMemoryStore();
  const referenceHash = await hashReference(newReference());
  await store.putPass({ referenceHash, sessionKey: 'a', expiresAt: 5000 });
  assert.deepEqual(await store.getPass(referenceHash), { sessionKey: 'a', expiresAt: 5000 });
  assert.equal(await store.getPass(await hashReference(newReference())), null);
  // The caller gets a copy.
  (await store.getPass(referenceHash)).sessionKey = 'b';
  assert.equal((await store.getPass(referenceHash)).sessionKey, 'a');
});

test('putPass throws TypeError for input that is not valid', async () => {
  const store = new MemoryStore();
  const referenceHash = await hashReference(newReference());
  await assert.rejects(store.putPass({ referenceHash: newReference().toUpperCase(), sessionKey: 'a', expiresAt: 1 }), TypeError);
  await assert.rejects(store.putPass({ referenceHash, sessionKey: '', expiresAt: 1 }), TypeError);
  await assert.rejects(store.putPass({ referenceHash, sessionKey: 'a', expiresAt: 'later' }), TypeError);
});

test('countUses counts uses with atMs > sinceMs', async () => {
  const store = new MemoryStore();
  await store.addUse('k', 1000);
  await store.addUse('k', 2000);
  await store.addUse('other', 2000);
  assert.equal(await store.countUses('k', 999), 2);
  assert.equal(await store.countUses('k', 1000), 1);
  assert.equal(await store.countUses('k', 2000), 0);
  assert.equal(await store.countUses('missing', 0), 0);
  await assert.rejects(store.addUse('', 1), TypeError);
  await assert.rejects(store.addUse('k', NaN), TypeError);
});

test('prune removes expired passes and old uses', async () => {
  const store = new MemoryStore({ keepUsesMs: 60_000 });
  const live = await hashReference(newReference());
  const old = await hashReference(newReference());
  await store.putPass({ referenceHash: live, sessionKey: 'a', expiresAt: 200_001 });
  await store.putPass({ referenceHash: old, sessionKey: 'a', expiresAt: 200_000 });
  await store.addUse('k', 100_000);
  await store.addUse('k', 150_000);
  await store.prune(200_000);
  assert.notEqual(await store.getPass(live), null);
  assert.equal(await store.getPass(old), null);
  assert.equal(await store.countUses('k', 0), 1);
});

test('listActivity returns the newest events first and keeps 200 events', async () => {
  const store = new MemoryStore();
  for (let i = 1; i <= 250; i += 1) await store.logActivity({ at: i, lane: 'agent', action: 'GET /x', status: 200, code: null, pass: null });
  const all = await store.listActivity({ limit: 1000 });
  assert.equal(all.length, 200);
  assert.equal(all[0].at, 250);
  assert.equal(all[199].at, 51);
  assert.deepEqual((await store.listActivity({ limit: 3 })).map((event) => event.at), [250, 249, 248]);
  assert.equal((await store.listActivity()).length, 50);
  await assert.rejects(store.logActivity(null), TypeError);
});

test('memoryStores gives 1 store for each session key', () => {
  const storeFor = memoryStores();
  const a = storeFor({}, 'a');
  assert.equal(storeFor({}, 'a'), a);
  assert.notEqual(storeFor({}, 'b'), a);
  assert.ok(a instanceof MemoryStore);
});

test('constructor options are checked', () => {
  assert.throws(() => new MemoryStore({ keepActivity: 0 }), TypeError);
  assert.throws(() => new MemoryStore({ keepUsesMs: 10 }), TypeError);
});

test('addUsesIfRoom adds a use to each key only when all keys have room', async () => {
  const store = new MemoryStore();
  await store.addUse('b', 1000);
  const entries = [
    { key: 'a', sinceMs: 0, limit: 2 },
    { key: 'b', sinceMs: 0, limit: 2 },
  ];
  assert.deepEqual(await store.addUsesIfRoom(entries, 2000), [0, 1]);
  assert.deepEqual(await store.addUsesIfRoom(entries, 3000), [1, 2]);
  // "b" had no room, so the store did not add a use to "a" or "b".
  assert.equal(await store.countUses('a', 0), 1);
  assert.equal(await store.countUses('b', 0), 2);
  // Only uses with atMs > sinceMs count.
  assert.deepEqual(await store.addUsesIfRoom([{ key: 'b', sinceMs: 1999, limit: 2 }], 4000), [1]);
  await assert.rejects(store.addUsesIfRoom([{ key: '', sinceMs: 0, limit: 1 }], 1), TypeError);
  await assert.rejects(store.addUsesIfRoom([{ key: 'a', sinceMs: 0, limit: 0 }], 1), TypeError);
  await assert.rejects(store.addUsesIfRoom('a', 1), TypeError);
});

test('putPass keeps the 10 passes that expire last for each session', async () => {
  const store = new MemoryStore();
  const hashes = [];
  for (let i = 0; i < 15; i += 1) {
    const referenceHash = await hashReference(newReference());
    hashes.push(referenceHash);
    await store.putPass({ referenceHash, sessionKey: 'a', expiresAt: 10_000 + i });
  }
  assert.equal(await store.getPass(hashes[4]), null);
  assert.notEqual(await store.getPass(hashes[5]), null);
  assert.notEqual(await store.getPass(hashes[14]), null);
  assert.throws(() => new MemoryStore({ keepPasses: 0 }), TypeError);
});

test('1 store for many sessions keeps the sessions apart', async () => {
  const store = new MemoryStore({ keepPasses: 2, keepActivity: 3 });
  const alice = await hashReference(newReference());
  await store.putPass({ referenceHash: alice, sessionKey: 'alice', expiresAt: 5_000 });
  // Bob gets many passes that expire later. They do not remove the pass of Alice.
  for (let i = 0; i < 5; i += 1) {
    await store.putPass({ referenceHash: await hashReference(newReference()), sessionKey: 'bob', expiresAt: 9_000 + i });
  }
  assert.deepEqual(await store.getPass(alice), { sessionKey: 'alice', expiresAt: 5_000 });

  const event = (at) => ({ at, lane: 'agent', action: 'GET /x', status: 200, code: null, pass: null });
  await store.logActivity(event(1), { sessionKey: 'alice' });
  for (let i = 2; i <= 6; i += 1) await store.logActivity(event(i), { sessionKey: 'bob' });
  assert.deepEqual((await store.listActivity({ sessionKey: 'alice' })).map((e) => e.at), [1]);
  assert.deepEqual((await store.listActivity({ sessionKey: 'bob' })).map((e) => e.at), [6, 5, 4]);
  assert.deepEqual(await store.listActivity({ sessionKey: 'carol' }), []);
  assert.deepEqual(await store.listActivity(), [], 'events with a session key are not in the list without a key');
});
