// Tests for the "exports" field of package.json.
// The tests import the package by its own name. Node.js permits this
// "self-reference" for a package with an "exports" field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json has the expected exports', () => {
  assert.equal(pkg.name, '@nekuda/webmcp-agentlane');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./browser', './cloudflare', './cloudflare/waf', './core']);
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test('"./core" exports the core functions', async () => {
  const core = await import('@nekuda/webmcp-agentlane/core');
  for (const name of ['signProof', 'verifyProof', 'issuePass', 'checkBudgets', 'recordUse', 'checkAndRecordUse', 'rateLimitHeaders', 'activityEvent', 'logLine', 'MemoryStore']) {
    assert.equal(typeof core[name], 'function', name);
  }
});

test('"./cloudflare/waf" works in Node.js without "cloudflare:workers"', async () => {
  const { wafRules, orderedRules } = await import('@nekuda/webmcp-agentlane/cloudflare/waf');
  const rules = orderedRules(wafRules({ host: 'example.com', secret: 'test', scope: ['GET /api/items'] }));
  assert.deepEqual(rules.map((rule) => rule.action), ['block', 'block', 'skip']);
});

test('"./browser" exports the lane client and registerTools', async () => {
  const browser = await import('@nekuda/webmcp-agentlane/browser');
  assert.equal(typeof browser.createAgentLaneClient, 'function');
  assert.equal(typeof browser.registerTools, 'function');
});
