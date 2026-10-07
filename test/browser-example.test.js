// End-to-end tests for the notes example (examples/worker).
//
// The tests run in Node.js without Wrangler. They wrap the example site with
// withAgentLane() and a memory store. A small fake browser keeps the session
// cookie, sends the Origin header and runs the real page tools
// (examples/worker/page/tools.js) with the real lane client.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withAgentLane } from '../src/cloudflare/worker.js';
import { memoryStores } from '../src/core/index.js';
import { createAgentLaneClient, registerTools } from '../src/browser/agentlane.js';
import { createNotesSite, laneOptions, LANE_SCOPE } from '../examples/worker/site.js';
import { noteTools } from '../examples/worker/page/tools.js';

const ORIGIN = 'http://notes.test';
const SECRET = 'example-secret-0123456789abcdef0123456789abcdef';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const files = {
  pageHtml: read('../examples/worker/page/index.html'),
  appScript: read('../examples/worker/page/app.js'),
  toolsScript: read('../examples/worker/page/tools.js'),
  laneScript: read('../src/browser/agentlane.js'),
};

function makeWorker({ secret = SECRET } = {}) {
  const site = createNotesSite(files);
  const events = [];
  const worker = withAgentLane(site, {
    ...laneOptions(site),
    store: memoryStores(),
    onAgentRequest: (event) => events.push(event),
  });
  return { worker, env: { AGENTLANE_SECRET: secret }, events };
}

// A fake browser for 1 person: it keeps the cookie and sends Origin on POST.
function fakeBrowser({ worker, env }) {
  let cookie = '';
  const requests = [];
  async function browserFetch(path, init = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') headers.set('Origin', ORIGIN);
    const request = new Request(new URL(path, ORIGIN), { ...init, method, headers });
    requests.push({ method, path, lane: headers.has('X-Agent-Session') });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    return response;
  }
  return { fetch: browserFetch, requests, cookie: () => cookie };
}

async function postJson(browser, path, data) {
  return browser.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// Register the page tools with a fake WebMCP API and return them by name.
async function pageTools(t, lane) {
  const registered = new Map();
  const modelContext = {
    async registerTool(tool, { signal } = {}) {
      registered.set(tool.name, tool);
      if (signal) signal.addEventListener('abort', () => registered.delete(tool.name));
    },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { modelContext }, configurable: true, writable: true });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'document', before);
    else delete globalThis.document;
  });
  const controller = new AbortController();
  assert.equal(await registerTools(noteTools(), { client: lane, signal: controller.signal }), true);
  return { registered, controller };
}

describe('notes example: page and files', () => {
  test('the page has a strict CSP with a new nonce on each script and style', async () => {
    const { worker, env } = makeWorker();
    const first = await worker.fetch(new Request(`${ORIGIN}/`), env, {});
    const second = await worker.fetch(new Request(`${ORIGIN}/`), env, {});
    assert.equal(first.status, 200);
    const csp = first.headers.get('Content-Security-Policy');
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, '\\$&')}' 'strict-dynamic'`));
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.notEqual(second.headers.get('Content-Security-Policy'), csp, 'each page gets a new nonce');

    const html = await first.text();
    assert.ok(!html.includes('__NONCE__'));
    const tags = html.match(/<(script|style)\b[^>]*>/g);
    assert.equal(tags.length, 2);
    for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    assert.match(html, /<script type="module" nonce="[^"]+" src="\/app.js"><\/script>/);
  });

  test('the Worker serves the lane client and the page scripts as JavaScript', async () => {
    const { worker, env } = makeWorker();
    for (const [path, source] of [
      ['/agentlane.js', files.laneScript],
      ['/app.js', files.appScript],
      ['/tools.js', files.toolsScript],
    ]) {
      const response = await worker.fetch(new Request(ORIGIN + path), env, {});
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(await response.text(), source);
    }
  });

  test('the page imports the lane client from /agentlane.js', () => {
    assert.match(files.appScript, /from '\/agentlane\.js'/);
    assert.match(files.appScript, /from '\/tools\.js'/);
  });

  test('wrangler.jsonc binds the Durable Object store with SQLite and has no secret', () => {
    const text = read('../examples/worker/wrangler.jsonc');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    assert.equal(config.main, 'worker.js');
    assert.deepEqual(config.durable_objects.bindings, [{ name: 'AGENTLANE', class_name: 'AgentLaneStore' }]);
    assert.deepEqual(config.migrations[0].new_sqlite_classes, ['AgentLaneStore']);
    assert.ok(!('vars' in config) || !('AGENTLANE_SECRET' in config.vars));
    const vars = read('../examples/worker/.dev.vars.example');
    assert.match(vars, /^AGENTLANE_SECRET=replace-with-a-random-secret$/m);
  });

  test('the tools have the expected names, schemas and annotations', () => {
    const [listNotes, addNote] = noteTools();
    assert.equal(listNotes.name, 'list_notes');
    assert.equal(listNotes.annotations.readOnlyHint, true);
    assert.equal(listNotes.annotations.untrustedContentHint, true);
    assert.equal(addNote.name, 'add_note');
    assert.equal(addNote.annotations.consequentialHint, true);
    assert.deepEqual(addNote.inputSchema.required, ['text']);
    assert.deepEqual(LANE_SCOPE, ['GET /api/notes', 'POST /api/notes']);
  });
});

describe('notes example: the agent lane', () => {
  test('sign-in sets an HttpOnly session cookie', async () => {
    const browser = fakeBrowser(makeWorker());
    const response = await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('Set-Cookie');
    assert.match(setCookie, /^notes_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  });

  test('the tools work through the agent lane, and the site sees the lane', async (t) => {
    const setup = makeWorker();
    const browser = fakeBrowser(setup);
    await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    await postJson(browser, '/api/notes', { text: 'from the person' });

    const lane = createAgentLaneClient({ fetchImpl: browser.fetch });
    const { registered } = await pageTools(t, lane);

    const added = await registered.get('add_note').execute({ text: 'from the agent' }, {});
    assert.equal(added.note.text, 'from the agent');
    assert.equal(added.note.lane, 'agent');

    const listed = await registered.get('list_notes').execute({}, {});
    assert.deepEqual(
      listed.notes.map((note) => [note.lane, note.text]),
      [
        ['agent', 'from the agent'],
        ['human', 'from the person'],
      ],
    );
    assert.ok(!JSON.stringify([added, listed]).match(/[a-f0-9]{64}/), 'a tool result has no reference');

    const laneRequests = browser.requests.filter((request) => request.lane);
    assert.deepEqual(
      laneRequests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/notes', 'GET /api/notes'],
    );
    assert.deepEqual(
      setup.events.map((event) => `${event.action} ${event.status}`),
      ['POST /agentlane/pass 201', 'POST /api/notes 201', 'GET /api/notes 200'],
    );

    // The person can read the activity log on the human lane.
    const activity = await (await browser.fetch('/agentlane/activity')).json();
    assert.deepEqual(
      activity.events.map((event) => event.action),
      ['GET /api/notes', 'POST /api/notes', 'POST /agentlane/pass'],
    );
  });

  test('add_note stops at the "notes-write" budget with the wait time', async (t) => {
    const browser = fakeBrowser(makeWorker());
    await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    const lane = createAgentLaneClient({ fetchImpl: browser.fetch });
    const { registered } = await pageTools(t, lane);
    const addNote = registered.get('add_note');

    for (let index = 1; index <= 5; index++) await addNote.execute({ text: `note ${index}` }, {});
    await assert.rejects(addNote.execute({ text: 'note 6' }, {}), /The budget "notes-write" has no room now\. Try again in \d+ seconds\./);

    // The human lane has no agent budget.
    const response = await postJson(browser, '/api/notes', { text: 'from the person' });
    assert.equal(response.status, 201);
  });

  test('after sign-out the tools stop with the session error', async (t) => {
    const browser = fakeBrowser(makeWorker());
    await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    const lane = createAgentLaneClient({ fetchImpl: browser.fetch });
    const { registered, controller } = await pageTools(t, lane);
    const listNotes = registered.get('list_notes');
    await listNotes.execute({}, {});

    await postJson(browser, '/api/demo/sign-out', {});
    assert.equal(browser.cookie(), '');
    // The lane sends HTTP 401 with the code "session". The client does not get a new pass.
    const before = browser.requests.length;
    await assert.rejects(listNotes.execute({}, {}), /^Error: Sign in to the site to use the agent lane\.$/);
    assert.deepEqual(browser.requests.slice(before), [{ method: 'GET', path: '/api/notes', lane: true }]);

    controller.abort();
    assert.equal(registered.size, 0);
  });

  test('a request with a bad proof never gets to the human lane', async () => {
    const browser = fakeBrowser(makeWorker());
    await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    const response = await browser.fetch('/api/notes', {
      headers: { 'X-Agent-Session': 'a'.repeat(64), 'X-Agent-Proof': 'not a proof' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'lane-headers');
  });

  test('the example refuses the placeholder secret', async () => {
    const browser = fakeBrowser(makeWorker({ secret: 'replace-with-a-random-secret' }));
    await postJson(browser, '/api/demo/sign-in', { name: 'dana' });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const response = await postJson(browser, '/agentlane/pass', {});
      assert.equal(response.status, 503);
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /set AGENTLANE_SECRET to a random value/);
  });

  test('the human lane rejects a POST from another origin', async () => {
    const { worker, env } = makeWorker();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/demo/sign-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' },
        body: JSON.stringify({ name: 'dana' }),
      }),
      env,
      {},
    );
    assert.equal(response.status, 403);
  });
});
