// Cloudflare Worker adapter for the agent lane.
//
// withAgentLane(handler, options) wraps the site's Worker. It does 3 things:
//
// 1. It responds to the pass request (POST /agentlane/pass by default).
// 2. It responds to the activity request (GET /agentlane/activity by default).
// 3. It checks each request that has a lane header before the site's
//    handler gets the request.
//
// A request with no lane header goes to the handler with no change.
// A request with a lane header never goes to the human lane. It passes all
// checks, or it gets an error response.

import {
  REFERENCE_PATTERN,
  PROOF_PATTERN,
  MAX_TTL_SECONDS,
  actionKey,
  verifyProof,
  issuePass,
  hashReference,
  normalizeScope,
  inScope,
  validateBudgets,
  checkAndRecordUse,
  rateLimitHeaders,
  activityEvent,
  logLine,
} from '../core/index.js';

/** Default lane header names. */
export const DEFAULT_HEADERS = Object.freeze({
  reference: 'X-Agent-Session',
  proof: 'X-Agent-Proof',
});

/** Default limit on pass requests: 5 passes in 30 seconds for each session. */
export const DEFAULT_PASS_LIMIT = Object.freeze({ limit: 5, windowSeconds: 30 });

/** Name of the budget that limits pass requests. */
export const PASS_BUDGET_NAME = 'agentlane.pass';

/** The shortest secret that the adapter accepts, in bytes. */
export const MIN_SECRET_BYTES = 32;

const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PATH_PATTERN = /^\/[^\s?#]*$/;
const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;

const MESSAGES = {
  'lane-headers': 'The agent lane headers are missing or not valid. Send 1 reference header and 1 proof header.',
  scope: 'The pass does not permit this action.',
  proof: 'The proof is not valid or has expired. Get a new pass.',
  session: 'Sign in to the site to use the agent lane.',
  pass: 'The pass is not valid for this session or has expired. Get a new pass.',
  origin: 'The pass request must come from a page of the site.',
  unavailable: 'The agent lane is not available now. Try again later.',
};

/**
 * Wrap a Worker handler with the agent lane.
 *
 * @param {Function | {fetch: Function}} handler The site's Worker: a fetch function or an object with fetch().
 * @param {object} options
 * @param {(env: object) => string} options.secret  Returns the signing secret, for example env.AGENTLANE_SECRET.
 *   The secret must have 32 bytes or more. If it is shorter, the adapter responds with HTTP 503.
 * @param {(request: Request, env: object) => Promise<string|null>} options.session
 *   Returns a stable key for the signed-in session of the person, or null.
 *   Do not return the raw session cookie. Do not read the request body.
 * @param {string[]} options.scope  The actions that a pass permits, for example ["POST /api/orders"].
 * @param {object[]} [options.budgets=[]]  Budgets. See src/core/budget.js.
 * @param {string} [options.passPath='/agentlane/pass']
 * @param {string} [options.activityPath='/agentlane/activity']
 * @param {number} [options.ttlSeconds=900]  Lifetime of a pass and its proofs.
 * @param {{reference?: string, proof?: string}} [options.headers]  Lane header names.
 * @param {(env: object, sessionKey: string) => object} [options.store]
 *   Returns the store for a session. The default uses the Durable Object binding env.AGENTLANE.
 *   The adapter gives the session key to logActivity and listActivity. Thus 1 store can hold
 *   the data of many sessions and still keep the sessions apart.
 * @param {(env: object) => string} [options.allowedOrigin]
 *   Returns the origin that may request a pass. The default is the origin of the request URL.
 * @param {{limit: number, windowSeconds: number} | null} [options.passLimit]
 *   Limit on pass requests for each session. The default is 5 in 30 seconds. Set null to remove it.
 * @param {(event: object) => void} [options.onAgentRequest]
 *   Gets each activity event. The default writes logLine(event) to console.log.
 * @param {() => number} [options.now]  Returns the time in epoch milliseconds. For tests.
 * @returns {{fetch: (request: Request, env: object, ctx: object) => Promise<Response>}}
 *   Also forwards the site's other Worker event handlers with their original this.
 */
export function withAgentLane(handler, options = {}) {
  const callHandler = handlerFunction(handler);
  const config = readOptions(options);

  async function fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reference = request.headers.get(config.headers.reference);
    const proof = request.headers.get(config.headers.proof);

    if (reference !== null || proof !== null) {
      return laneRequest({ request, env, ctx, url, reference, proof });
    }
    if (url.pathname === config.passPath) return passRequest({ request, env, ctx, url });
    return route(request, env, ctx, url);
  }

  // The activity endpoint, or the site's handler.
  function route(request, env, ctx, url) {
    if (url.pathname === config.activityPath) return activityRequest({ request, env, url });
    return callHandler(request, env, ctx);
  }

  // The checks run in a fixed order. See SPEC.md.
  async function laneRequest({ request, env, ctx, url, reference, proof }) {
    const nowMs = config.now();
    const method = request.method.toUpperCase();
    const path = url.pathname;
    const action = safeActionKey(method, path);
    let sessionKey;
    let store;
    let budgetCheck;
    // The store gets the event only after check 5 finds the store of the session.
    const record = (status, code) =>
      report({ ctx, store, sessionKey, event: activityEvent({ at: nowMs, reference, action, status, code }) });

    // 1. Both headers are present and well-formed.
    if (!reference || !proof || !REFERENCE_PATTERN.test(reference) || !PROOF_PATTERN.test(proof)) {
      await record(403, 'lane-headers');
      return failure(403, 'lane-headers');
    }
    // 2. The action is in the scope.
    if (!inScope(config.scope, method, path)) {
      await record(403, 'scope');
      return failure(403, 'scope');
    }

    try {
      // 3. The proof is valid for this reference, action and time.
      const check = await verifyProof(readSecret(config, env), reference, method, path, proof, {
        nowSeconds: Math.floor(nowMs / 1000),
        ttlSeconds: config.ttlSeconds,
      });
      if (!check.ok) {
        await record(403, 'proof');
        return failure(403, 'proof');
      }

      // 4. The person's session is valid.
      sessionKey = await config.session(request, env);
      if (!isSessionKey(sessionKey)) {
        await record(401, 'session');
        return failure(401, 'session');
      }

      // 5. The pass exists, belongs to this session and has not expired.
      const sessionStore = config.store(env, sessionKey);
      const pass = await sessionStore.getPass(await hashReference(reference));
      store = sessionStore;
      if (!pass || pass.sessionKey !== sessionKey || !(pass.expiresAt > nowMs)) {
        await record(403, 'pass');
        return failure(403, 'pass');
      }

      // 6. Every budget that covers the action has room.
      // The store counts the request only when it passes. It does the check
      // and the count in 1 step, so requests at the same time cannot go over a limit.
      const usage = { budgets: config.budgets, method, path, reference, sessionKey, nowMs };
      budgetCheck = await checkAndRecordUse(store, usage);
      if (!budgetCheck.ok) {
        await record(429, 'budget');
        return budgetFailure(budgetCheck);
      }
    } catch (error) {
      console.error('agentlane: a lane check failed.', error instanceof Error ? error.message : 'unknown error');
      await record(503, 'unavailable');
      return failure(503, 'unavailable');
    }

    // 7. Send the request to the site's handler.
    let response;
    try {
      response = await route(request, env, ctx, url);
    } catch (error) {
      await record(500, 'handler');
      throw error;
    }
    response = addHeaders(response, rateLimitHeaders(budgetCheck.applied));
    await record(response.status, null);
    return response;
  }

  async function passRequest({ request, env, ctx, url }) {
    const nowMs = config.now();
    let sessionKey;
    let store;
    const record = (status, code, reference, action = `POST ${config.passPath}`) =>
      report({ ctx, store, sessionKey, event: activityEvent({ at: nowMs, reference, action, status, code }) });

    if (request.method !== 'POST') {
      // The adapter does not know the session yet, so only the hook gets this event.
      await record(405, 'method', null, safeActionKey(request.method.toUpperCase(), config.passPath));
      return json({ error: 'Use POST to get a pass.', code: 'method' }, 405, { Allow: 'POST' });
    }

    try {
      const expected = config.allowedOrigin ? config.allowedOrigin(env) : url.origin;
      if (!expected || request.headers.get('Origin') !== expected) {
        await record(403, 'origin');
        return failure(403, 'origin');
      }
      const key = await config.session(request, env);
      if (!isSessionKey(key)) {
        await record(401, 'session');
        return failure(401, 'session');
      }
      sessionKey = key;
      const secret = readSecret(config, env);
      store = config.store(env, sessionKey);

      // Limit pass requests. Without this limit, a page could get many
      // passes and avoid the budgets with per "pass".
      let applied = [];
      if (config.passBudgets.length) {
        const usage = { budgets: config.passBudgets, method: 'POST', path: config.passPath, sessionKey, nowMs };
        const check = await checkAndRecordUse(store, usage);
        if (!check.ok) {
          await record(429, 'budget');
          return budgetFailure(check);
        }
        applied = check.applied;
      }

      await store.prune(nowMs);
      const pass = await issuePass({
        secret,
        scope: config.scope,
        ttlSeconds: config.ttlSeconds,
        nowMs,
        budgets: config.budgets,
      });
      await store.putPass({
        referenceHash: await hashReference(pass.reference),
        sessionKey,
        expiresAt: pass.expiresAt,
      });
      await record(201, null, pass.reference);
      return json(pass, 201, rateLimitHeaders(applied));
    } catch (error) {
      console.error('agentlane: the pass request failed.', error instanceof Error ? error.message : 'unknown error');
      await record(503, 'unavailable');
      return failure(503, 'unavailable');
    }
  }

  async function activityRequest({ request, env, url }) {
    if (request.method !== 'GET') {
      return json({ error: 'Use GET to read the activity log.', code: 'method' }, 405, { Allow: 'GET' });
    }
    try {
      const sessionKey = await config.session(request, env);
      if (!isSessionKey(sessionKey)) return failure(401, 'session');
      const store = config.store(env, sessionKey);
      const events = await store.listActivity({ sessionKey, limit: activityLimit(url) });
      return json({ events: events.map(publicEvent) }, 200);
    } catch (error) {
      console.error('agentlane: the activity request failed.', error instanceof Error ? error.message : 'unknown error');
      return failure(503, 'unavailable');
    }
  }

  // Send the event to the hook, and to the store when the session is known.
  // Checks 1 to 4 run before the adapter knows the session. Their events go
  // only to the hook. The adapter does not look up the session only to log
  // a rejected request, because the early checks must stay cheap.
  // The store gets the session key with the event, so that 1 store can keep
  // the events of many sessions apart. The event itself has no session key.
  // A failure here never changes the response.
  async function report({ ctx, store, sessionKey, event }) {
    try {
      const result = config.onAgentRequest(event);
      if (result && typeof result.then === 'function') keepAlive(ctx, result);
    } catch (error) {
      console.error('agentlane: onAgentRequest failed.', error instanceof Error ? error.message : 'unknown error');
    }
    if (!store) return;
    let write;
    try {
      write = Promise.resolve(store.logActivity(event, { sessionKey }));
    } catch (error) {
      write = Promise.reject(error);
    }
    write = write.catch((error) => {
      console.error('agentlane: the activity log write failed.', error instanceof Error ? error.message : 'unknown error');
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }

  const wrapped = { fetch };
  // ponytail: fixed Worker event list; extend it when Cloudflare adds event handlers.
  for (const name of ['scheduled', 'queue', 'email', 'tail', 'tailStream', 'trace']) {
    const eventHandler = handler[name];
    if (typeof eventHandler === 'function') wrapped[name] = eventHandler.bind(handler);
  }
  return wrapped;
}

function readOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('withAgentLane: the options must be an object.');
  }
  const {
    secret,
    session,
    scope,
    budgets = [],
    passPath = '/agentlane/pass',
    activityPath = '/agentlane/activity',
    ttlSeconds = 900,
    headers = {},
    store = durableObjectStore,
    allowedOrigin,
    passLimit = DEFAULT_PASS_LIMIT,
    onAgentRequest = (event) => console.log(logLine(event)),
    now = Date.now,
  } = options;

  if (typeof secret !== 'function') {
    throw new TypeError('withAgentLane: "secret" must be a function, for example (env) => env.AGENTLANE_SECRET.');
  }
  if (typeof session !== 'function') {
    throw new TypeError('withAgentLane: "session" must be a function that returns the session key or null.');
  }
  for (const [name, value] of [['store', store], ['onAgentRequest', onAgentRequest], ['now', now]]) {
    if (typeof value !== 'function') throw new TypeError(`withAgentLane: "${name}" must be a function.`);
  }
  if (allowedOrigin !== undefined && typeof allowedOrigin !== 'function') {
    throw new TypeError('withAgentLane: "allowedOrigin" must be a function, for example (env) => env.SITE_ORIGIN.');
  }
  for (const [name, value] of [['passPath', passPath], ['activityPath', activityPath]]) {
    if (typeof value !== 'string' || !PATH_PATTERN.test(value)) {
      throw new TypeError(`withAgentLane: "${name}" must start with "/" and have no spaces or "?".`);
    }
  }
  if (passPath === activityPath) {
    throw new TypeError('withAgentLane: "passPath" and "activityPath" must be different.');
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new TypeError(`withAgentLane: "ttlSeconds" must be a whole number from 1 to ${MAX_TTL_SECONDS}.`);
  }

  const names = { ...DEFAULT_HEADERS, ...headers };
  for (const key of ['reference', 'proof']) {
    if (typeof names[key] !== 'string' || !HEADER_PATTERN.test(names[key])) {
      throw new TypeError(`withAgentLane: "headers.${key}" must be a valid HTTP header name.`);
    }
  }
  if (names.reference.toLowerCase() === names.proof.toLowerCase()) {
    throw new TypeError('withAgentLane: the reference header and the proof header must be different.');
  }

  const actions = normalizeScope(scope);
  if (actions.includes(`POST ${passPath}`)) {
    throw new TypeError('withAgentLane: the scope must not contain the pass request.');
  }
  const normalBudgets = validateBudgets(budgets, actions);
  if (normalBudgets.some((budget) => budget.name === PASS_BUDGET_NAME)) {
    throw new TypeError(`withAgentLane: the budget name "${PASS_BUDGET_NAME}" is reserved.`);
  }

  let passBudgets = [];
  if (passLimit !== null) {
    if (!passLimit || typeof passLimit !== 'object') {
      throw new TypeError('withAgentLane: "passLimit" must be { limit, windowSeconds } or null.');
    }
    passBudgets = validateBudgets([
      {
        name: PASS_BUDGET_NAME,
        actions: [`POST ${passPath}`],
        limit: passLimit.limit,
        windowSeconds: passLimit.windowSeconds,
        per: 'session',
      },
    ]);
  }

  return {
    secret,
    session,
    scope: actions,
    budgets: normalBudgets,
    passBudgets,
    passPath,
    activityPath,
    ttlSeconds,
    headers: { reference: names.reference, proof: names.proof },
    store,
    allowedOrigin,
    onAgentRequest,
    now,
  };
}

// The default store: one Durable Object for each session.
function durableObjectStore(env, sessionKey) {
  const namespace = env?.AGENTLANE;
  if (!namespace || typeof namespace.idFromName !== 'function') {
    throw new Error('the Durable Object binding AGENTLANE is missing. Add it to the Wrangler configuration.');
  }
  return namespace.get(namespace.idFromName(sessionKey));
}

function handlerFunction(handler) {
  if (typeof handler === 'function') return handler;
  if (handler && typeof handler.fetch === 'function') return (request, env, ctx) => handler.fetch(request, env, ctx);
  throw new TypeError('withAgentLane: the handler must be a function or an object with a fetch() method.');
}

function isSessionKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

// Return the secret, or throw if it is missing or short. A short secret lets
// a person find the secret from the proofs in a pass.
function readSecret(config, env) {
  const secret = config.secret(env);
  if (typeof CryptoKey !== 'undefined' && secret instanceof CryptoKey) return secret;
  let bytes = -1;
  if (typeof secret === 'string') bytes = new TextEncoder().encode(secret).byteLength;
  else if (secret instanceof Uint8Array || secret instanceof ArrayBuffer) bytes = secret.byteLength;
  if (bytes < 1) throw new Error('the secret is missing. Set it with "wrangler secret put".');
  if (bytes < MIN_SECRET_BYTES) {
    throw new Error(`the secret is too short. Use ${MIN_SECRET_BYTES} bytes or more, for example from "openssl rand -hex 32".`);
  }
  return secret;
}

// The action key for the log. It never throws.
function safeActionKey(method, path) {
  try {
    return actionKey(method, path);
  } catch {
    return `${method.slice(0, 16)} ${path.slice(0, 180)}`;
  }
}

function activityLimit(url) {
  const value = Number(url.searchParams.get('limit'));
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(value, MAX_ACTIVITY_LIMIT);
}

// Copy only the public fields of an event.
function publicEvent(event) {
  const { at, lane, action, status, code, pass } = event;
  return { at, lane, action, status, code, pass };
}

function keepAlive(ctx, promise) {
  const safe = Promise.resolve(promise).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function failure(status, code) {
  return json({ error: MESSAGES[code], code }, status);
}

function budgetFailure(check) {
  return json(
    {
      error: `The budget "${check.budget}" has no room now. Try again in ${check.retryAfter} seconds.`,
      code: 'budget',
      budget: check.budget,
      retryAfter: check.retryAfter,
    },
    429,
    { 'Retry-After': String(check.retryAfter), ...rateLimitHeaders(check.applied) },
  );
}

// Add headers to the response. Responses from fetch() have immutable
// headers, so the function makes a copy when it must.
function addHeaders(response, extra) {
  const entries = Object.entries(extra ?? {});
  if (entries.length === 0 || response.status === 101) return response;
  try {
    for (const [name, value] of entries) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of entries) copy.headers.set(name, value);
    return copy;
  }
}
