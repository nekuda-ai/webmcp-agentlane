// Tests for scripts/waf-rules.mjs.
// The secret in these tests is a test value. Never put a real secret here.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/waf-rules.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/waf-rules.mjs', import.meta.url));
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const CONFIG = {
  host: 'shop.example',
  scope: ['GET /api/items', 'POST /api/orders'],
  ttlSeconds: 900,
  headers: { reference: 'X-Agent-Session', proof: 'X-Agent-Proof' },
};

let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlane-waf-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function configFile(name, value) {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

// Run the script in a child process, from the temporary folder.
function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('scripts/waf-rules.mjs', () => {
  test('refuses to run without AGENTLANE_SECRET', async () => {
    const path = await configFile('config.json', CONFIG);
    const result = run([path]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /AGENTLANE_SECRET is not set/);
  });

  test('accepts a short secret for tests, with a warning', async () => {
    const path = await configFile('config.json', CONFIG);
    const result = run([path], { AGENTLANE_SECRET: 'test' });
    assert.equal(result.code, 0, result.err);
    const rules = JSON.parse(result.out);
    assert.equal(rules.length, 4);
    assert.ok(rules[2].expression.includes('is_timed_hmac_valid_v0("test"'));
    assert.match(result.err, /Warning: AGENTLANE_SECRET has fewer than 32 characters/);
    // The warning does not show the secret.
    assert.ok(!result.err.includes('"test"'));
  });

  test('writes no warning for a secret of 32 characters or more', async () => {
    const path = await configFile('config.json', CONFIG);
    const result = run([path], { AGENTLANE_SECRET: SECRET });
    assert.equal(result.code, 0, result.err);
    assert.ok(!result.err.includes('Warning'));
  });

  test('refuses a config file that contains a secret', async () => {
    const path = await configFile('with-secret.json', { ...CONFIG, secret: 'do-not-put-it-here' });
    const result = run([path], { AGENTLANE_SECRET: SECRET });
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, /contains "secret"/);
    assert.ok(!result.err.includes('do-not-put-it-here'));
  });

  test('refuses unknown fields and bad JSON', async () => {
    const extra = await configFile('extra.json', { ...CONFIG, zone: 'abc' });
    assert.equal(run([extra], { AGENTLANE_SECRET: SECRET }).code, 1);
    const broken = await configFile('broken.json', '{ "host": ');
    assert.equal(run([broken], { AGENTLANE_SECRET: SECRET }).code, 1);
    assert.equal(run([join(dir, 'missing.json')], { AGENTLANE_SECRET: SECRET }).code, 1);
  });

  test('shows the usage for --help and for bad arguments', () => {
    const help = run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: AGENTLANE_SECRET=<secret> node scripts\/waf-rules\.mjs/);
    assert.equal(run([]).code, 2);
    assert.equal(run(['a.json', 'b.json'], { AGENTLANE_SECRET: SECRET }).code, 2);
    assert.equal(run(['--unknown', 'a.json'], { AGENTLANE_SECRET: SECRET }).code, 2);
  });

  test('prints the rules as a JSON list, block rules first', async () => {
    const path = await configFile('config.json', CONFIG);
    const result = run([path], { AGENTLANE_SECRET: SECRET });
    assert.equal(result.code, 0, result.err);
    const rules = JSON.parse(result.out);
    assert.deepEqual(
      rules.map((rule) => [rule.action, rule.description]),
      [
        ['block', 'Agent lane - reject invalid agent writes'],
        ['block', 'Agent lane - reject invalid agent reads'],
        ['skip', 'Agent lane - signed agent GET requests'],
        ['skip', 'Agent lane - signed agent POST requests'],
      ],
    );
    for (const rule of rules) {
      assert.deepEqual(Object.keys(rule).filter((key) => !['logging'].includes(key)).sort(), [
        'action',
        'action_parameters',
        'description',
        'enabled',
        'expression',
      ]);
    }
    assert.ok(rules[2].expression.includes(`is_timed_hmac_valid_v0("${SECRET}"`));
    assert.match(result.err, /contains the secret/);
  });

  test('prints 1 rule on each line with --lines', async () => {
    const path = await configFile('config.json', { ...CONFIG, origin: 'https://shop.example' });
    const result = run([path, '--lines'], { AGENTLANE_SECRET: SECRET });
    assert.equal(result.code, 0, result.err);
    const lines = result.out.trim().split('\n');
    assert.equal(lines.length, 5);
    assert.equal(JSON.parse(lines[4]).description, 'Agent lane - pass request');
  });

  test('writes no files', async () => {
    const path = await configFile('config.json', CONFIG);
    const beforeFiles = (await readdir(dir)).sort();
    assert.equal(run([path], { AGENTLANE_SECRET: SECRET }).code, 0);
    assert.deepEqual((await readdir(dir)).sort(), beforeFiles);
  });

  test('main() reports a bad scope without the secret', async () => {
    const path = await configFile('bad-scope.json', { ...CONFIG, scope: ['GET /api/"x'] });
    const out = [];
    const err = [];
    const code = await main([path], { AGENTLANE_SECRET: SECRET }, { out: (t) => out.push(t), err: (t) => err.push(t) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.ok(!err.join('\n').includes(SECRET));
  });
});
