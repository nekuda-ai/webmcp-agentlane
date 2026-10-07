import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionKey, inScope, normalizeScope, parseAction } from '../src/core/scope.js';
import { actionKey as actionKeyFromProof } from '../src/core/proof.js';

test('actionKey makes "METHOD /path" without the query string', () => {
  assert.equal(actionKey('POST', '/api/reservations'), 'POST /api/reservations');
  assert.equal(actionKey('post', '/api/reservations'), 'POST /api/reservations');
  assert.equal(actionKey('GET', '/api/availability?date=2026-10-07&partySize=2'), 'GET /api/availability');
  assert.equal(actionKey('GET', '/api/restaurants#top'), 'GET /api/restaurants');
  assert.equal(actionKey('GET', '/'), 'GET /');
  assert.equal(actionKeyFromProof, actionKey);
});

test('actionKey throws TypeError for a method or a path that is not valid', () => {
  assert.throws(() => actionKey('POST', 'api/reservations'), TypeError);
  assert.throws(() => actionKey('POST', ''), TypeError);
  assert.throws(() => actionKey('POST', '/api/a b'), TypeError);
  assert.throws(() => actionKey('P0ST', '/api/x'), TypeError);
  assert.throws(() => actionKey('', '/api/x'), TypeError);
  assert.throws(() => actionKey(undefined, '/api/x'), TypeError);
  assert.throws(() => actionKey('GET', `/${'a'.repeat(600)}`), TypeError);
});

test('parseAction returns the method and the path', () => {
  assert.deepEqual(parseAction('POST /api/reservations'), { method: 'POST', path: '/api/reservations' });
  assert.deepEqual(parseAction(' get   /api/restaurants '), { method: 'GET', path: '/api/restaurants' });
  assert.throws(() => parseAction('POST'), TypeError);
  assert.throws(() => parseAction('POST /a /b'), TypeError);
  assert.throws(() => parseAction('POST /api/x?y=1'), TypeError);
  assert.throws(() => parseAction(7), TypeError);
});

test('normalizeScope returns action keys in normal form, without duplicates, in the first order', () => {
  assert.deepEqual(
    normalizeScope(['get /api/restaurants', 'POST /api/reservations', 'GET /api/restaurants']),
    ['GET /api/restaurants', 'POST /api/reservations'],
  );
});

test('normalizeScope throws TypeError for a list that is not valid', () => {
  assert.throws(() => normalizeScope([]), TypeError);
  assert.throws(() => normalizeScope(undefined), TypeError);
  assert.throws(() => normalizeScope('GET /api/x'), TypeError);
  assert.throws(() => normalizeScope(['GET /api/x?y=1']), TypeError);
  assert.throws(() => normalizeScope(['GET']), TypeError);
  assert.throws(() => normalizeScope(['GET api/x']), TypeError);
  assert.throws(() => normalizeScope([123]), TypeError);
});

test('inScope checks the method and the exact path', () => {
  const scope = normalizeScope(['GET /api/restaurants', 'POST /api/reservations']);
  assert.equal(inScope(scope, 'GET', '/api/restaurants'), true);
  assert.equal(inScope(scope, 'get', '/api/restaurants?q=sushi'), true);
  assert.equal(inScope(scope, 'POST', '/api/reservations'), true);
  assert.equal(inScope(scope, 'GET', '/api/reservations'), false);
  assert.equal(inScope(scope, 'DELETE', '/api/reservations'), false);
  assert.equal(inScope(scope, 'POST', '/api/reservations/1'), false);
  assert.equal(inScope(scope, 'POST', '/api/reservations/'), false);
  assert.equal(inScope(scope, 'POST', '/API/reservations'), false);
});

test('inScope returns false for input that is not valid and never throws', () => {
  const scope = ['GET /api/restaurants'];
  assert.equal(inScope(scope, undefined, '/api/restaurants'), false);
  assert.equal(inScope(scope, 'GET', undefined), false);
  assert.equal(inScope(scope, 'GET', 'api/restaurants'), false);
  assert.equal(inScope(undefined, 'GET', '/api/restaurants'), false);
  assert.equal(inScope('GET /api/restaurants', 'GET', '/api/restaurants'), false);
});
