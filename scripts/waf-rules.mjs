#!/usr/bin/env node
// Print the Cloudflare WAF custom rules for the agent lane as JSON.
//
// Usage:
//   AGENTLANE_SECRET=... node scripts/waf-rules.mjs <config.json> [--lines]
//
// The config file has no secret. The script reads the secret from the
// AGENTLANE_SECRET environment variable. The script writes no files.
// The output contains the secret. Do not save the output in the repository.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { wafRules, orderedRules } from '../src/cloudflare/waf.js';

const USAGE = `Usage: AGENTLANE_SECRET=<secret> node scripts/waf-rules.mjs <config.json> [--lines]

Print the agent lane WAF custom rules as JSON.

Options:
  --lines   Print one rule on each line. Use this to send each rule in a loop.
  --help    Show this help.

The config file is JSON with these fields:
  {
    "host": "example.com",
    "scope": ["GET /api/items", "POST /api/orders"],
    "ttlSeconds": 900,
    "headers": { "reference": "X-Agent-Session", "proof": "X-Agent-Proof" },
    "origin": "https://example.com",
    "passPath": "/agentlane/pass"
  }
"ttlSeconds", "headers", "origin" and "passPath" are optional.
Use the same scope, ttlSeconds and headers as in the Worker.

Add each rule to the zone in the order of the output. The block rules must come first.
Send each rule to the Cloudflare Rulesets API:
  POST /zones/<zone-id>/rulesets/<ruleset-id>/rules
See docs/cloudflare.md for the full steps.

Use a secret with 32 or more random characters, for example from "openssl rand -hex 32".
If the secret is shorter, the command writes a warning.

The output contains the secret. Do not save it in a file or in the repository.`;

/** The command writes a warning if the secret has fewer characters than this. */
const MIN_SECRET_LENGTH = 32;

const CONFIG_FIELDS = new Set(['host', 'scope', 'ttlSeconds', 'headers', 'origin', 'passPath', 'label']);

/**
 * Run the command. Returns the exit code.
 * @param {string[]} args  Command arguments without "node" and the script path.
 * @param {Record<string, string|undefined>} env  Environment variables.
 * @param {{out: (text: string) => void, err: (text: string) => void}} io
 */
export async function main(args, env, io) {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const lines = args.includes('--lines');
  const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--lines');
  const files = args.filter((arg) => !arg.startsWith('-'));
  if (unknown.length || files.length !== 1) {
    io.err(USAGE);
    return 2;
  }

  const secret = env.AGENTLANE_SECRET;
  if (!secret) {
    io.err('Error: AGENTLANE_SECRET is not set. Set it in the environment. Do not put it in the config file.');
    return 2;
  }
  // A short secret is acceptable for a test, but not for a site.
  const shortSecret = secret.length < MIN_SECRET_LENGTH;

  let config;
  try {
    config = JSON.parse(await readFile(files[0], 'utf8'));
  } catch (error) {
    io.err(`Error: cannot read the config file "${files[0]}": ${error.message}`);
    return 1;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    io.err('Error: the config file must contain one JSON object.');
    return 1;
  }
  if ('secret' in config) {
    io.err('Error: the config file contains "secret". Remove it. Set AGENTLANE_SECRET in the environment.');
    return 1;
  }
  const extra = Object.keys(config).filter((key) => !CONFIG_FIELDS.has(key));
  if (extra.length) {
    io.err(`Error: the config file has unknown fields: ${extra.join(', ')}.`);
    return 1;
  }

  let rules;
  try {
    rules = orderedRules(wafRules({ ...config, secret }));
  } catch (error) {
    // Error messages from wafRules never contain the secret.
    io.err(`Error: ${error.message}`);
    return 1;
  }

  if (shortSecret) {
    io.err(
      `Warning: AGENTLANE_SECRET has fewer than ${MIN_SECRET_LENGTH} characters. ` +
        'Do not use these rules on a site. Make a secret with "openssl rand -hex 32".',
    );
  }
  io.err(`Made ${rules.length} rules. The output contains the secret. Do not save it in the repository.`);
  if (lines) {
    for (const rule of rules) io.out(JSON.stringify(rule));
  } else {
    io.out(JSON.stringify(rules, null, 2));
  }
  return 0;
}

const isScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isScript) {
  const code = await main(process.argv.slice(2), process.env, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
  process.exitCode = code;
}
