// The notes site of the example.
//
// DEMO ONLY. The sign-in has no password. The sessions and the notes stay
// in the memory of the Worker, and the Worker loses them when it restarts.
// A real site uses its own sign-in and a real database.
//
// The site has 2 lanes:
//
// - The human lane: the page and its forms. These requests have no lane headers.
// - The agent lane: the WebMCP tools of the page. withAgentLane() checks
//   these requests before they get to this handler.
//
// This file has no Wrangler imports. Thus the tests can load it in Node.js.

/** The name of the session cookie. The cookie is HttpOnly. */
export const SESSION_COOKIE = 'notes_session';

/** The actions that a pass permits. */
export const LANE_SCOPE = ['GET /api/notes', 'POST /api/notes'];

/** The budgets of the agent lane. See docs/budgets.md. */
export const LANE_BUDGETS = [
  { name: 'notes-read', actions: ['GET /api/notes'], limit: 30, windowSeconds: 60, per: 'session' },
  { name: 'notes-write', actions: ['POST /api/notes'], limit: 5, windowSeconds: 60, per: 'session' },
  { name: 'notes-hour', actions: '*', limit: 200, windowSeconds: 3600, per: 'session' },
];

const SESSION_SECONDS = 8 * 3600;
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_NOTE_LENGTH = 280;
const MAX_NOTES = 100;
const MAX_BODY_BYTES = 4096;
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = 'replace-with-a-random-secret';

/**
 * Make the notes site.
 *
 * @param {object} files  The text of the page files.
 * @param {string} files.pageHtml  The page. "__NONCE__" marks the place of the CSP nonce.
 * @param {string} files.appScript  The page code (page/app.js).
 * @param {string} files.toolsScript  The WebMCP tools (page/tools.js).
 * @param {string} files.laneScript  The lane client (src/browser/agentlane.js).
 * @returns {{fetch: (request: Request) => Promise<Response>, sessionKey: (request: Request) => Promise<string|null>}}
 */
export function createNotesSite({ pageHtml, appScript, toolsScript, laneScript }) {
  // DEMO ONLY: data in memory.
  // sessions: hash of the session token -> { name, expiresAt }
  // notes: name of the person -> notes, newest first
  const sessions = new Map();
  const notes = new Map();

  const scripts = {
    '/app.js': appScript,
    '/tools.js': toolsScript,
    '/agentlane.js': laneScript,
  };

  // Return the hash of the session token if the session is valid, or null.
  // The agent lane uses this hash as the session key. It is not the cookie.
  async function sessionKey(request) {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const key = await sha256Hex(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return key;
  }

  async function signedInName(request) {
    const key = await sessionKey(request);
    return key ? sessions.get(key).name : null;
  }

  async function fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    try {
      if (pathname === '/' && method === 'GET') return page(pageHtml);
      // The example has no icon. This response stops a 404 error in the console.
      if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (Object.prototype.hasOwnProperty.call(scripts, pathname) && method === 'GET') {
        return script(scripts[pathname]);
      }
      if (pathname.startsWith('/api/')) {
        if (method === 'POST') checkOrigin(request, url);
        return await api(request, url);
      }
      return text('Not found.', 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      throw error;
    }
  }

  async function api(request, url) {
    const route = `${request.method} ${url.pathname}`;

    if (route === 'POST /api/demo/sign-in') {
      const input = await readBody(request);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!NAME_PATTERN.test(name)) {
        throw new HttpError(400, 'Use a name with 1 to 32 letters, digits, "_" or "-".');
      }
      const token = randomHex(32);
      sessions.set(await sha256Hex(token), { name, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
      return json({ name }, 200, { 'Set-Cookie': sessionCookie(url, token, SESSION_SECONDS) });
    }

    if (route === 'POST /api/demo/sign-out') {
      const key = await sessionKey(request);
      if (key) sessions.delete(key);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(url, '', 0) });
    }

    if (route === 'GET /api/session') {
      return json({ name: await signedInName(request) });
    }

    if (url.pathname === '/api/notes') {
      const name = await signedInName(request);
      if (!name) throw new HttpError(401, 'Sign in to use the notes.');
      const list = notes.get(name) || [];

      if (request.method === 'GET') return json({ notes: list });

      if (request.method === 'POST') {
        const input = await readBody(request);
        const value = typeof input.text === 'string' ? input.text.trim() : '';
        if (value.length < 1 || value.length > MAX_NOTE_LENGTH) {
          throw new HttpError(400, `A note must have 1 to ${MAX_NOTE_LENGTH} characters.`);
        }
        // withAgentLane checked every request that has a lane header.
        // Thus the header shows which lane the request used.
        const lane = request.headers.has('X-Agent-Session') ? 'agent' : 'human';
        const note = { id: crypto.randomUUID(), text: value, lane, at: Date.now() };
        notes.set(name, [note, ...list].slice(0, MAX_NOTES));
        return json({ note }, 201);
      }
      return json({ error: 'Use GET or POST.' }, 405, { Allow: 'GET, POST' });
    }

    throw new HttpError(404, 'Not found.');
  }

  return { fetch, sessionKey };
}

/**
 * The options for withAgentLane().
 * @param {{sessionKey: (request: Request) => Promise<string|null>}} site
 */
export function laneOptions(site) {
  return {
    secret: (env) => checkSecret(env && env.AGENTLANE_SECRET),
    session: (request) => site.sessionKey(request),
    scope: LANE_SCOPE,
    budgets: LANE_BUDGETS,
  };
}

// Stop with an error if the secret is missing, short or the example value.
function checkSecret(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || secret === PLACEHOLDER_SECRET) {
    throw new Error(
      `set AGENTLANE_SECRET to a random value with ${MIN_SECRET_LENGTH} characters or more. See examples/worker/README.md.`,
    );
  }
  return secret;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The page and the scripts permit only scripts with the nonce, and the
// modules that those scripts import.
function securityHeaders(nonce) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "require-trusted-types-for 'script'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

function page(html) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(html.replaceAll('__NONCE__', nonce), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders(nonce) },
  });
}

function script(source) {
  return new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// A POST request must come from a page of the site.
function checkOrigin(request, url) {
  if (request.headers.get('Origin') !== url.origin) {
    throw new HttpError(403, 'The request must come from a page of the site.');
  }
}

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send the body as application/json.');
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'The body is too large.');
  }
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The next line sends the error.
  }
  throw new HttpError(400, 'Send a JSON object.');
}

function sessionCookie(url, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
