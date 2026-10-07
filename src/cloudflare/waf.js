// Cloudflare WAF custom rules for the agent lane.
//
// The edge can check a proof before the request reaches the Worker.
// Cloudflare's is_timed_hmac_valid_v0 function checks the same proof format
// that src/core/proof.js makes. These rules do two things:
//
// 1. Block a request that has a lane header but no valid proof.
// 2. Let a request with a valid proof skip Super Bot Fight Mode
//    (phase http_request_sbfm).
//
// The Worker still does all checks. The edge rules are an extra layer.
// Put the rejectInvalid rules before the skip rules in the ruleset.

import { normalizeScope } from '../core/index.js';

/** Default lane header names. They are the same as in the Worker adapter. */
export const DEFAULT_HEADERS = Object.freeze({
  reference: 'X-Agent-Session',
  proof: 'X-Agent-Proof',
});

/** Cloudflare accepts rule expressions of 4096 characters or fewer. */
export const MAX_EXPRESSION_LENGTH = 4096;

/** Length of the separator "?verify=" between the message and the proof. */
const SEPARATOR = '?verify=';

const REJECT_CONTENT = JSON.stringify({
  error: 'The pass reference or proof is not valid, or the proof has expired. Get a new pass.',
  code: 'proof',
});

const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// Characters that are safe in a quoted Cloudflare string without escapes.
const SAFE_STRING = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const PATH_PATTERN = /^\/[\x21\x24-\x3e\x40-\x5b\x5d-\x7e]*$/;
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/**
 * Make Cloudflare WAF custom rules that check agent lane proofs at the edge.
 *
 * @param {object} options
 * @param {string} options.host        Host name of the site, for example "example.com".
 * @param {string} options.secret      The same secret that the Worker uses to sign proofs.
 * @param {string[]} options.scope     Action keys, for example ["GET /api/items", "POST /api/orders"].
 * @param {number} [options.ttlSeconds=900] Proof lifetime. It must be the same as in the Worker.
 * @param {{reference?: string, proof?: string}} [options.headers] Lane header names.
 * @param {string} [options.label='Agent lane'] Prefix for each rule description.
 * @param {string} [options.origin]    Optional. The site origin, for example "https://example.com".
 *   If you set it, the result also has a skip rule for the pass request.
 * @param {string} [options.passPath='/agentlane/pass'] Path of the pass request. Used with origin.
 * @returns {{rejectInvalid: object[], skipBotFilterForValid: object[], skipBotFilterForPass?: object[]}}
 */
export function wafRules(options) {
  const {
    host,
    secret,
    scope,
    ttlSeconds = 900,
    headers = {},
    label = 'Agent lane',
    origin,
    passPath = '/agentlane/pass',
  } = options ?? {};

  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    throw new TypeError('wafRules: "host" must be a lower-case host name, for example "example.com".');
  }
  if (typeof secret !== 'string' || !SAFE_STRING.test(secret)) {
    throw new TypeError(
      'wafRules: "secret" must be printable ASCII without spaces, double quotes or backslashes.',
    );
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError('wafRules: "ttlSeconds" must be a whole number, 1 or more.');
  }
  if (typeof label !== 'string' || !/^[\w .-]{1,40}$/.test(label)) {
    throw new TypeError('wafRules: "label" must have 1 to 40 letters, digits, spaces, "_", "." or "-".');
  }

  const names = { ...DEFAULT_HEADERS, ...headers };
  for (const key of ['reference', 'proof']) {
    if (typeof names[key] !== 'string' || !HEADER_PATTERN.test(names[key])) {
      throw new TypeError(`wafRules: "headers.${key}" must be a valid HTTP header name.`);
    }
  }
  // Cloudflare stores request header names in lower case.
  const referenceHeader = names.reference.toLowerCase();
  const proofHeader = names.proof.toLowerCase();
  if (referenceHeader === proofHeader) {
    throw new TypeError('wafRules: the reference header and the proof header must be different.');
  }

  const groups = groupByMethod(normalizeScope(scope));
  const reads = groups.get('GET') ?? [];
  const writeMethods = [...groups.keys()].filter((method) => method !== 'GET').sort();

  const hostClause = `http.host eq ${quote(host)}`;
  const hasLaneHeader =
    `(has_key(http.request.headers, ${quote(referenceHeader)})` +
    ` or has_key(http.request.headers, ${quote(proofHeader)}))`;

  // The expression that is true when the request has a valid proof
  // for one of the paths of this method.
  const valid = (method, paths) => {
    const ref = `http.request.headers[${quote(referenceHeader)}]`;
    const proof = `http.request.headers[${quote(proofHeader)}]`;
    const pathClause =
      paths.length === 1
        ? `http.request.uri.path eq ${quote(paths[0])}`
        : `http.request.uri.path in {${paths.map(quote).join(' ')}}`;
    return [
      `coalesce(len(${ref}), 0) eq 1`,
      `coalesce(len(${proof}), 0) eq 1`,
      `len(coalesce(${ref}[0], "")) eq 64`,
      `http.request.method eq ${quote(method)}`,
      pathClause,
      `is_timed_hmac_valid_v0(${quote(secret)}, concat(coalesce(${ref}[0], ""), ${quote(`:${method}:`)}, ` +
        `http.request.uri.path, ${quote(SEPARATOR)}, coalesce(${proof}[0], "")), ` +
        `${ttlSeconds}, http.request.timestamp.sec, ${SEPARATOR.length})`,
    ].join(' and ');
  };

  // Rule 1: block non-GET requests with a lane header and no valid proof.
  let writeCondition = '';
  if (writeMethods.length === 1) {
    writeCondition = ` and not (${valid(writeMethods[0], groups.get(writeMethods[0]))})`;
  } else if (writeMethods.length > 1) {
    const any = writeMethods.map((method) => `(${valid(method, groups.get(method))})`).join(' or ');
    writeCondition = ` and not (${any})`;
  }
  const rejectWrites = blockRule(
    `${label} - reject invalid agent writes`,
    `${hostClause} and ${hasLaneHeader} and http.request.method ne "GET"${writeCondition}`,
  );

  // Rule 2: block GET requests with a lane header and no valid proof.
  const readCondition = reads.length ? ` and not (${valid('GET', reads)})` : '';
  const rejectReads = blockRule(
    `${label} - reject invalid agent reads`,
    `${hostClause} and ${hasLaneHeader} and http.request.method eq "GET"${readCondition}`,
  );

  // Rules 3+: let requests with a valid proof skip Super Bot Fight Mode.
  const skipBotFilterForValid = [];
  if (reads.length) {
    skipBotFilterForValid.push(
      skipRule(`${label} - signed agent GET requests`, `${hostClause} and (${valid('GET', reads)})`),
    );
  }
  for (const method of writeMethods) {
    skipBotFilterForValid.push(
      skipRule(
        `${label} - signed agent ${method} requests`,
        `${hostClause} and (${valid(method, groups.get(method))})`,
      ),
    );
  }

  const result = { rejectInvalid: [rejectWrites, rejectReads], skipBotFilterForValid };

  if (origin !== undefined) {
    if (typeof origin !== 'string' || !ORIGIN_PATTERN.test(origin)) {
      throw new TypeError('wafRules: "origin" must be an https origin, for example "https://example.com".');
    }
    if (typeof passPath !== 'string' || !PATH_PATTERN.test(passPath)) {
      throw new TypeError('wafRules: "passPath" must start with "/" and have no spaces, double quotes, backslashes or "?".');
    }
    // The pass request has no proof. The Worker checks the session and the Origin.
    result.skipBotFilterForPass = [
      skipRule(
        `${label} - pass request`,
        `${hostClause} and http.request.method eq "POST" and http.request.uri.path eq ${quote(passPath)}` +
          ` and any(http.request.headers["origin"][*] eq ${quote(origin)})`,
      ),
    ];
  }

  for (const rule of [...result.rejectInvalid, ...skipBotFilterForValid]) {
    if (rule.expression.length > MAX_EXPRESSION_LENGTH) {
      throw new RangeError(
        `wafRules: the rule "${rule.description}" has ${rule.expression.length} characters. ` +
          `Cloudflare accepts ${MAX_EXPRESSION_LENGTH} or fewer. Use fewer paths in the scope.`,
      );
    }
  }
  return result;
}

/**
 * Put all rules in the order that the ruleset needs:
 * the block rules first, then the skip rules.
 */
export function orderedRules(rules) {
  return [
    ...rules.rejectInvalid,
    ...rules.skipBotFilterForValid,
    ...(rules.skipBotFilterForPass ?? []),
  ];
}

function groupByMethod(actionKeys) {
  const groups = new Map();
  for (const key of actionKeys) {
    const space = key.indexOf(' ');
    const method = key.slice(0, space);
    const path = key.slice(space + 1);
    if (!/^[A-Z]{1,16}$/.test(method)) {
      throw new TypeError(`wafRules: the action "${key}" has an unsupported method.`);
    }
    if (!PATH_PATTERN.test(path)) {
      throw new TypeError(`wafRules: the path in "${key}" must have no spaces, double quotes, backslashes or "?".`);
    }
    if (!groups.has(method)) groups.set(method, []);
    const paths = groups.get(method);
    if (!paths.includes(path)) paths.push(path);
  }
  return groups;
}

// All values pass a strict pattern check before they get here,
// so they never contain a quote or a backslash.
function quote(value) {
  return `"${value}"`;
}

function blockRule(description, expression) {
  return {
    description,
    action: 'block',
    expression,
    action_parameters: {
      response: { status_code: 403, content_type: 'application/json', content: REJECT_CONTENT },
    },
    enabled: true,
  };
}

function skipRule(description, expression) {
  return {
    description,
    action: 'skip',
    expression,
    action_parameters: { phases: ['http_request_sbfm'] },
    logging: { enabled: true },
    enabled: true,
  };
}
