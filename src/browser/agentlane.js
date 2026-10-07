// The lane client: the agent lane code for pages.
//
// The page code of a site uses this module to send WebMCP tool requests
// through the agent lane. The module has 2 parts:
//
//   createAgentLaneClient()  gets a pass from the site and signs each tool
//                            request with the reference and the proof.
//   registerTools()          gives the tools of the page to the WebMCP API
//                            of the browser.
//
// This is a plain ES2020 module with no imports. A page can load it with
// <script type="module"> or copy it into its own bundle.
//
// Rules for the pass:
//
// - The client keeps the pass in memory only. It never writes the pass to
//   localStorage, sessionStorage, IndexedDB or cookies.
// - Do not put the reference or a proof in a tool result. The agent does
//   not need them, and tool results can go to other places.

/** The default lane header names. They must match the server. */
export const DEFAULT_HEADERS = Object.freeze({
  reference: 'X-Agent-Session',
  proof: 'X-Agent-Proof',
});

const REFERENCE_PATTERN = /^[a-f0-9]{64}$/;
const PROOF_PATTERN = /^(\d{10})-((?:[A-Za-z0-9]|%2B|%2F){43}%3D)$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// The WebMCP draft permits these characters in a tool name.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
// The client gets a new pass and sends the request again 1 time only after
// HTTP 403 with 1 of these codes. The lane (the edge or the server) sends
// these codes before the site handler runs. The client never sends a request
// again after a response from the site handler, because the handler can have
// done the action already.
const RETRY_STATUS = 403;
const RETRY_CODES = ['proof', 'pass'];
// The longest pass lifetime that the client accepts as real: 1 day.
const MAX_LIFETIME_MS = 86400 * 1000;
// The base for paths when the code runs without a page, for example in tests.
const NO_PAGE_BASE = 'http://agentlane.invalid';
const MAX_SERVER_TEXT = 200;

/**
 * Make a client for the agent lane.
 *
 * @param {object} [options]
 * @param {string} [options.passUrl='/agentlane/pass']  The path of the pass request.
 * @param {{reference?: string, proof?: string}} [options.headers]  Lane header names.
 * @param {number} [options.refreshMarginMs=5000]
 *   The client gets a new pass when the current pass has less time left than this.
 * @param {Function} [options.fetchImpl=globalThis.fetch]  The fetch function to use.
 * @returns {{fetch: (path: string | URL, init?: RequestInit) => Promise<Response>,
 *            pass: () => Promise<object>, clear: () => void}}
 */
export function createAgentLaneClient(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('agentlane: the options must be an object.');
  }
  const { passUrl = '/agentlane/pass', headers = {}, refreshMarginMs = 5000, fetchImpl } = options;

  if (typeof passUrl !== 'string' || passUrl === '') {
    throw new TypeError('agentlane: "passUrl" must be a path, for example "/agentlane/pass".');
  }
  if (!Number.isFinite(refreshMarginMs) || refreshMarginMs < 0) {
    throw new TypeError('agentlane: "refreshMarginMs" must be 0 or more.');
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new TypeError('agentlane: "fetchImpl" must be a function.');
  }
  const names = headerNames(headers);
  const passTarget = resolveTarget(passUrl);

  // The current pass: { pass, refreshAt }. refreshAt uses the clock of the page.
  let current = null;
  // The pass request in flight. Only 1 pass request runs at a time.
  let pending = null;

  // Call fetch as a plain function. Some browsers reject a call of fetch
  // with "this" set to another object.
  function send(url, init) {
    const impl = fetchImpl || globalThis.fetch;
    if (typeof impl !== 'function') throw new Error('agentlane: fetch is not available.');
    return impl(url, init);
  }

  /**
   * Return the current pass. Get a new pass if there is no pass or if the
   * pass expires soon. The pass object is frozen.
   */
  async function pass() {
    if (current && Date.now() <= current.refreshAt) return current.pass;
    if (!pending) {
      const request = requestPass();
      pending = request;
      request.then(
        (entry) => {
          // If clear() ran during the request, do not keep the result.
          if (pending === request) {
            current = entry;
            pending = null;
          }
        },
        () => {
          if (pending === request) pending = null;
        },
      );
    }
    const entry = await pending;
    return entry.pass;
  }

  async function requestPass() {
    const response = await send(passTarget.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    const receivedAt = Date.now();
    const body = await readJson(response);
    if (!response.ok) throw serverError('the site did not give a pass', response, body);

    const value = readPass(body);
    if (!value) throw new Error('agentlane: the pass from the site is not valid.');
    return { pass: value, refreshAt: receivedAt + lifetimeMs(value, receivedAt) - refreshMarginMs };
  }

  /** Forget the pass. Use this when the person signs out. */
  function clear() {
    current = null;
    pending = null;
  }

  // Forget the pass only if it is the pass that a failed request used.
  // Thus 2 failed requests at the same time do not cancel the new pass.
  function drop(used) {
    if (current && current.pass === used) current = null;
  }

  function laneInit(init, method, value, action) {
    if (!Object.prototype.hasOwnProperty.call(value.proofs, action)) {
      throw new Error(`agentlane: action not in scope: ${action}`);
    }
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set(names.reference, value.reference);
    requestHeaders.set(names.proof, value.proofs[action]);
    return {
      ...init,
      method,
      headers: requestHeaders,
      credentials: 'same-origin',
      cache: 'no-store',
      // Do not follow redirects. The browser sends the lane headers again
      // to the new URL, and the proof is for 1 action only.
      redirect: 'error',
    };
  }

  /**
   * Send 1 tool request through the agent lane. It has the same arguments
   * as fetch(). The path must be on the origin of the page.
   */
  async function laneFetch(path, init = {}) {
    if (!init || typeof init !== 'object') {
      throw new TypeError('agentlane: the request options must be an object.');
    }
    const target = resolveTarget(path);
    const method = String(init.method || 'GET').toUpperCase();
    const action = `${method} ${target.path}`;
    const signal = init.signal || null;
    if (signal && signal.aborted) throw abortReason(signal);

    let used = await untilAborted(pass(), signal);
    let response = await send(target.url, laneInit(init, method, used, action));

    if (canSendAgain(init.body) && (await laneRejectedPass(response))) {
      // The server rejected the pass, or the edge rejected the proof.
      // The site handler did not run. Get a new pass and send the request again 1 time.
      cancelBody(response);
      drop(used);
      used = await untilAborted(pass(), signal);
      response = await send(target.url, laneInit(init, method, used, action));
    }
    return response;
  }

  return Object.freeze({ fetch: laneFetch, pass, clear });
}

/**
 * Give tools to the WebMCP API of the browser.
 *
 * The function uses document.modelContext (W3C WebMCP draft). If that does
 * not exist, it uses navigator.modelContext (older Chrome versions).
 *
 * Each tool is { name, title?, description, inputSchema?, annotations?, execute }.
 * The function calls execute(input, { lane, signal }). "lane" is the client.
 * "signal" is the AbortSignal of the tool call, if the browser gives one.
 *
 * @param {object[]} tools
 * @param {object} [options]
 * @param {object} [options.client]  A client from createAgentLaneClient().
 * @param {AbortSignal} [options.signal]  Abort it to remove all the tools.
 * @param {string[]} [options.exposedTo]  Origins for the WebMCP "exposedTo" option.
 * @returns {false | Promise<true>}
 *   false if the browser has no WebMCP API. Otherwise a promise that
 *   resolves to true when all tools are registered. If 1 tool fails, the
 *   function removes the tools that it registered, and the promise rejects.
 */
export function registerTools(tools, options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('agentlane: the options must be an object.');
  }
  const { client, signal, exposedTo } = options;
  checkTools(tools);
  if (client !== undefined && (!client || typeof client.fetch !== 'function')) {
    throw new TypeError('agentlane: "client" must come from createAgentLaneClient().');
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('agentlane: "signal" must be an AbortSignal.');
  }
  if (exposedTo !== undefined && !(Array.isArray(exposedTo) && exposedTo.every((item) => typeof item === 'string'))) {
    throw new TypeError('agentlane: "exposedTo" must be a list of origins.');
  }

  const modelContext = findModelContext();
  if (!modelContext) return false;
  return registerAll(modelContext, tools, { client, signal, exposedTo });
}

async function registerAll(modelContext, tools, { client, signal, exposedTo }) {
  if (signal && signal.aborted) throw abortReason(signal);

  // 1 controller removes all the tools of this call.
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(abortReason(signal)), { once: true });

  try {
    for (const tool of tools) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      await registerOne(modelContext, tool, { client, signal: controller.signal, exposedTo });
    }
  } catch (error) {
    controller.abort(error);
    throw error;
  }
  return true;
}

async function registerOne(modelContext, tool, { client, signal, exposedTo }) {
  const entry = {
    name: tool.name,
    description: tool.description,
    execute: (input, callOptions) =>
      tool.execute(input, { lane: client, signal: callOptions ? callOptions.signal : undefined }),
  };
  if (tool.title !== undefined) entry.title = tool.title;
  if (tool.inputSchema !== undefined) entry.inputSchema = tool.inputSchema;
  if (tool.annotations !== undefined) entry.annotations = { ...tool.annotations };

  // The draft API reads options.signal and removes the tool on abort.
  // An older API can ignore it. The getter shows if the API read it.
  let signalRead = false;
  const registerOptions = {
    get signal() {
      signalRead = true;
      return signal;
    },
  };
  if (exposedTo !== undefined) registerOptions.exposedTo = exposedTo.slice();

  await modelContext.registerTool(entry, registerOptions);

  if (!signalRead && typeof modelContext.unregisterTool === 'function') {
    const remove = () => {
      try {
        modelContext.unregisterTool(tool.name);
      } catch (error) {
        // The tool is not registered. There is nothing to remove.
      }
    };
    if (signal.aborted) remove();
    else signal.addEventListener('abort', remove, { once: true });
  }
}

// Return the WebMCP API object, or null.
function findModelContext() {
  const doc = globalThis.document;
  const nav = globalThis.navigator;
  const candidates = [doc && doc.modelContext, nav && nav.modelContext];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.registerTool === 'function') return candidate;
  }
  return null;
}

function checkTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError('agentlane: "tools" must be a list.');
  const seen = new Set();
  tools.forEach((tool, index) => {
    const label = `agentlane: tool ${index + 1}`;
    if (!tool || typeof tool !== 'object') throw new TypeError(`${label}: it must be an object.`);
    if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw new TypeError(`${label}: the name must have 1 to 128 letters, digits, "_", "-" or ".".`);
    }
    if (seen.has(tool.name)) {
      throw new TypeError(`${label}: 2 tools have the name "${tool.name}". Give each tool a different name.`);
    }
    seen.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.trim() === '') {
      throw new TypeError(`${label}: "${tool.name}" must have a description.`);
    }
    if (typeof tool.execute !== 'function') {
      throw new TypeError(`${label}: "${tool.name}" must have an execute function.`);
    }
    if (tool.title !== undefined && typeof tool.title !== 'string') {
      throw new TypeError(`${label}: the title of "${tool.name}" must be a string.`);
    }
    for (const key of ['inputSchema', 'annotations']) {
      const value = tool[key];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
        throw new TypeError(`${label}: "${key}" of "${tool.name}" must be an object.`);
      }
    }
  });
}

function headerNames(headers) {
  if (!headers || typeof headers !== 'object') {
    throw new TypeError('agentlane: "headers" must be an object.');
  }
  const names = {
    reference: headers.reference || DEFAULT_HEADERS.reference,
    proof: headers.proof || DEFAULT_HEADERS.proof,
  };
  for (const key of ['reference', 'proof']) {
    if (typeof names[key] !== 'string' || !HEADER_PATTERN.test(names[key])) {
      throw new TypeError(`agentlane: "headers.${key}" must be a valid HTTP header name.`);
    }
  }
  if (names.reference.toLowerCase() === names.proof.toLowerCase()) {
    throw new TypeError('agentlane: the reference header and the proof header must be different.');
  }
  return names;
}

// Return { url, path } for a request path.
// In a page, the URL must have the same origin as the page.
// Without a page (for example in tests), the path must start with "/".
function resolveTarget(input) {
  const text = typeof URL !== 'undefined' && input instanceof URL ? input.href : input;
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('agentlane: the path must be a string, for example "/api/notes".');
  }
  const page = globalThis.location;
  if (page && typeof page.href === 'string' && page.origin && page.origin !== 'null') {
    const doc = globalThis.document;
    const base = doc && typeof doc.baseURI === 'string' ? doc.baseURI : page.href;
    const url = new URL(text, base);
    if (url.origin !== page.origin) {
      throw new Error('agentlane: the agent lane sends requests only to the origin of the page.');
    }
    return { url: url.href, path: url.pathname };
  }
  if (!text.startsWith('/') || text.startsWith('//')) {
    throw new Error('agentlane: without a page, the path must start with "/".');
  }
  const url = new URL(text, NO_PAGE_BASE);
  return { url: url.pathname + url.search, path: url.pathname };
}

// Check the pass from the server and return a frozen copy, or null.
// The pass of tableforagents.com has no "scope" field. Then the scope is
// the list of actions that have a proof.
function readPass(body) {
  if (!body || typeof body !== 'object') return null;
  const { reference, expiresAt, proofs } = body;
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (!proofs || typeof proofs !== 'object' || Array.isArray(proofs)) return null;

  const copy = {};
  for (const action of Object.keys(proofs)) {
    const proof = proofs[action];
    if (typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) return null;
    copy[action] = proof;
  }
  const scope = Array.isArray(body.scope)
    ? body.scope.filter((action) => typeof action === 'string')
    : Object.keys(copy);
  const budgets = Array.isArray(body.budgets) ? body.budgets : [];
  return deepFreeze({ reference, expiresAt, scope, proofs: copy, budgets });
}

// Return the time in milliseconds that the pass stays valid after the page
// got it. The clock of the page can differ from the clock of the server.
// Thus the client measures the lifetime of the pass from the timestamp in
// a proof, and it does not compare expiresAt with the clock of the page.
function lifetimeMs(value, receivedAt) {
  const first = Object.keys(value.proofs)[0];
  if (first !== undefined) {
    const issuedAt = Number(value.proofs[first].slice(0, 10)) * 1000;
    const lifetime = value.expiresAt - issuedAt;
    if (lifetime > 0 && lifetime <= MAX_LIFETIME_MS) return lifetime;
  }
  return value.expiresAt - receivedAt;
}

async function readJson(response) {
  const type = response.headers.get('Content-Type') || '';
  if (!type.toLowerCase().includes('application/json')) return null;
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

// Make an error from an error response of the site. The error has the
// fields status, code and retryAfter when the server sends them.
function serverError(text, response, body) {
  let message = `agentlane: ${text} (HTTP ${response.status}).`;
  if (body && typeof body.error === 'string') message += ` ${body.error.slice(0, MAX_SERVER_TEXT)}`;
  const error = new Error(message);
  error.status = response.status;
  if (body && typeof body.code === 'string') error.code = body.code;
  const retryAfter = Number((body && body.retryAfter) || response.headers.get('Retry-After'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
  return error;
}

// Return true if the lane rejected the pass or the proof: HTTP 403 with the
// code "proof" or "pass" in a JSON body. The function reads a copy of the
// body, so the caller can still read the response.
async function laneRejectedPass(response) {
  if (response.status !== RETRY_STATUS || typeof response.clone !== 'function') return false;
  const body = await readJson(response.clone());
  return Boolean(body) && typeof body === 'object' && RETRY_CODES.includes(body.code);
}

// A body that is a stream can be read only 1 time.
function canSendAgain(body) {
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

function cancelBody(response) {
  if (response.body && typeof response.body.cancel === 'function') {
    response.body.cancel().catch(() => {});
  }
}

// Wait for a promise. Stop early if the signal aborts.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal) {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortSignal(value) {
  return Boolean(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
