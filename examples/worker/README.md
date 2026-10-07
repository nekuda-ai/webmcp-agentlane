# Notes example: a Cloudflare Worker with the agent lane

This example is a small notes site on Cloudflare Workers. The person signs in and keeps short notes.
The page gives 2 WebMCP tools to agents: `list_notes` and `add_note`.
The tools send their requests through the agent lane, with a pass, budgets and an activity log.

> **Demo only.** The sign-in has no password. The sessions and the notes stay in the memory of the Worker.
> The Worker loses them when it restarts. Do not use this sign-in on a real site.

## Files

| File | What it does |
|---|---|
| `worker.js` | The Worker. It wraps the site with `withAgentLane()` from `src/cloudflare/index.js`. |
| `site.js` | The site: demo sign-in, notes API, the page and its CSP, and the agent lane options. |
| `page/index.html` | The page. The Worker puts a new CSP nonce in it for each request. |
| `page/app.js` | The page code. It registers the tools after sign-in and removes them at sign-out. |
| `page/tools.js` | The 2 WebMCP tools. |
| `wrangler.jsonc` | The Wrangler configuration, with the Durable Object `AGENTLANE`. |
| `.dev.vars.example` | A template for the local secret `AGENTLANE_SECRET`. |
| `agentlane.waf.json` | A config file for the optional edge rules. It has no secret. |

The Worker serves the lane client `src/browser/agentlane.js` at `/agentlane.js`.
Wrangler imports the file as text, because of the `rules` in `wrangler.jsonc`.
Thus the page always uses the same lane client as the tests.

## Run the example on your computer

You need Node.js 22 or later.

1. In the repository root, run `npm install`. This installs Wrangler.
2. Go to the folder `examples/worker`.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Make a random secret with `openssl rand -hex 32`.
5. In `.dev.vars`, replace `replace-with-a-random-secret` with the secret.
6. Run `npx wrangler dev`.
7. Open http://localhost:8787 in the browser.
8. Sign in with a name, for example `dana`.

You can also start the example from the repository root with `npm run example`.

If the secret is missing, short or the example value, the Worker does not issue passes.
It responds to the pass request with HTTP 503 and writes the reason to the log.

## Use the tools

After sign-in, the page registers 2 WebMCP tools.

| Tool | Action | WebMCP annotations | Budget |
|---|---|---|---|
| `list_notes` | `GET /api/notes` | `readOnlyHint`, `untrustedContentHint` | `notes-read`: 30 requests in 60 seconds |
| `add_note` | `POST /api/notes` | `consequentialHint` | `notes-write`: 5 requests in 60 seconds |

The budget `notes-hour` also applies to both tools: 200 requests in 3600 seconds.
Each budget counts the requests of 1 session (`per: 'session'`).
The adapter also limits pass requests to 5 in 30 seconds for each session.

`list_notes` has `untrustedContentHint`, because people write the notes.
A note can contain text that tells an agent to do something.

If the browser has no WebMCP API, the page shows a message and registers no tools.
The page uses `document.modelContext` (W3C WebMCP draft). If that does not exist, it uses `navigator.modelContext`.

## What to look at

- **The notes list.** Each note shows the lane that added it: "agent" or "human".
- **The agent activity table.** It shows each pass request and each tool request, with the HTTP status.
- **The 6th `add_note` call in the same 60-second window.** The tool fails with the budget name and the wait time.
- **The RateLimit headers.** Each tool response has `RateLimit` and `RateLimit-Policy`.
- **Sign-out.** The page aborts the signal of the tools. The browser removes the tools, and the page forgets the pass.

## Check the agent lane with curl

You can send tool requests without a browser. Each step uses the cookie file `cookies.txt`.

1. Sign in:

   ```sh
   curl -c cookies.txt -H 'Origin: http://localhost:8787' -H 'Content-Type: application/json' \
     -d '{"name":"dana"}' http://localhost:8787/api/demo/sign-in
   ```

2. Get a pass. The response has the `reference` and 1 proof for each action in `proofs`.

   ```sh
   curl -b cookies.txt -H 'Origin: http://localhost:8787' -H 'Content-Type: application/json' \
     -d '{}' http://localhost:8787/agentlane/pass
   ```

3. Send a tool request. Use the reference and the proof for `GET /api/notes`.

   ```sh
   curl -i -b cookies.txt -H 'X-Agent-Session: <reference>' -H 'X-Agent-Proof: <proof>' \
     http://localhost:8787/api/notes
   ```

4. Send the same request with the proof for `POST /api/notes`. The site responds with HTTP 403 and the code `proof`.

5. Send the request without `-b cookies.txt`. The site responds with HTTP 401 and the code `session`.

## Security of the page

- **Content Security Policy.** The page permits only the scripts and styles that have the nonce of the request.
  `page/app.js` imports `/agentlane.js` and `/tools.js`. The browser gives the nonce to these imported modules.
- **Session cookie.** The cookie is `HttpOnly` and `SameSite=Strict`. On HTTPS, it is also `Secure`.
- **Origin check.** Each `POST` request to `/api/` must have the `Origin` of the site.
- **The pass.** The lane client keeps the pass in memory only. Tool results never contain the reference or a proof.
- **Lane headers.** A request with a lane header never goes to the human lane. It passes all checks, or it gets an error.

## Make the edge rules (optional)

The edge rules are for a site on Cloudflare. They do not run on your computer.
To see the rules for this example, run this command in the repository root:

```sh
AGENTLANE_SECRET=test node scripts/waf-rules.mjs examples/worker/agentlane.waf.json
```

The command prints 5 rules as JSON. It writes a warning, because `test` is a short secret.
For a real site, use the secret of the Worker and your own host. See [docs/cloudflare.md](../../docs/cloudflare.md#check-passes-at-the-edge).

## Deploy the example (optional)

The example is for use on your computer. If you deploy it, the demo sign-in can lose sessions.
Cloudflare can run the Worker in more than 1 place, and each place has its own memory.

To deploy it for a short test:

1. Run `npx wrangler secret put AGENTLANE_SECRET` and give a random secret.
2. Run `npx wrangler deploy`.

## Tests

`npm test` in the repository root also tests this example.
The file `test/browser-example.test.js` runs the site, the agent lane and the real page tools in Node.js.
It uses a memory store, not a Durable Object.
