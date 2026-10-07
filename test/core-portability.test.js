import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The core must run in Cloudflare Workers, in browsers and in Node.js 22.
// Thus it uses Web Crypto and web APIs only.
const dir = new URL('../src/core/', import.meta.url);

test('src/core has no Node.js imports and no runtime dependencies', async () => {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 7);
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? match[2];
      assert.match(specifier, /^\.\/[a-z-]+\.js$/, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /\brequire\(|\bprocess\.|\bBuffer\b|node:/, name);
  }
});

test('the package entry point exports the core API', async () => {
  const core = await import('../src/core/index.js');
  for (const name of [
    'REFERENCE_PATTERN', 'PROOF_PATTERN', 'actionKey', 'signProof', 'verifyProof',
    'newReference', 'issuePass', 'normalizeScope', 'inScope',
    'validateBudgets', 'checkBudgets', 'recordUse', 'rateLimitHeaders',
    'activityEvent', 'logLine', 'MemoryStore', 'createMemoryStore',
  ]) {
    assert.ok(name in core, name);
  }
});
