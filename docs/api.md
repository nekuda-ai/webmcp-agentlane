# API reference

This document lists the exports of the package `@nekuda/webmcp-agentlane`.
The package has 4 entry points:

| Entry point | File | Where it runs |
|---|---|---|
| `@nekuda/webmcp-agentlane/core` | `src/core/index.js` | Cloudflare Workers, browsers and Node.js 22. It uses Web Crypto only. |
| `@nekuda/webmcp-agentlane/cloudflare` | `src/cloudflare/index.js` | Cloudflare Workers only. It imports `cloudflare:workers`. |
| `@nekuda/webmcp-agentlane/cloudflare/waf` | `src/cloudflare/waf.js` | Node.js and Workers. Use it to make the edge rules in Node.js. |
| `@nekuda/webmcp-agentlane/browser` | `src/browser/agentlane.js` | The page. It is a plain ES2020 module with no imports. |

The package has no runtime dependencies.
If an option or a configuration value is not valid, a function throws a `TypeError`.
Bad values from a request never cause an exception. They cause an error response.

## Core

### Proofs

| Export | Description |
|---|---|
| `REFERENCE_PATTERN` | `/^[a-f0-9]{64}$/`. The format of a reference. |
| `PROOF_PATTERN` | `/^(\d{10})-((?:[A-Za-z0-9]\|%2B\|%2F){43}%3D)$/`. The format of a proof. |
| `DEFAULT_TTL_SECONDS` | `900`. The default lifetime of a pass. |
| `MAX_TTL_SECONDS` | `86400`. The longest lifetime of a pass. |
| `actionKey(method, path)` | Returns the action key, for example `"POST /api/reservations"`. It changes the method to upper case and removes the query string and the fragment. |
| `importSecret(secret)` | Returns an HMAC-SHA256 `CryptoKey`. The secret can be a string, a `Uint8Array`, an `ArrayBuffer` or a `CryptoKey`. It must not be empty. |
| `sha256Hex(value)` | Returns the SHA-256 hash of a string as 64 lower-case hex characters. |
| `signProof(secret, reference, method, path, unixSeconds?)` | Returns the proof for 1 action. The default time is now. |
| `verifyProof(secret, reference, method, path, proof, options?)` | Verifies 1 proof. See below. |

`verifyProof` options:

| Option | Default | Meaning |
|---|---|---|
| `nowSeconds` | The current Unix time | The time of the check, in seconds. |
| `ttlSeconds` | `900` | The lifetime of the proof, from 1 to 86400 seconds. |

`verifyProof` returns `{ ok: true }` or `{ ok: false, code: 'proof', reason }`.
The `reason` is `'format'`, `'future'`, `'expired'` or `'signature'`.
The function compares the MAC in constant time with `crypto.subtle.verify`.

### Passes

| Export | Description |
|---|---|
| `newReference()` | Returns a new reference: 32 random bytes as 64 lower-case hex characters. |
| `hashReference(reference)` | Returns the SHA-256 hash of the reference. The store keeps this hash, not the reference. |
| `issuePass(options)` | Returns a new pass. See below. |

`issuePass` options:

| Option | Default | Meaning |
|---|---|---|
| `secret` | Required | The signing secret. |
| `scope` | Required | The action keys that the pass permits. |
| `ttlSeconds` | `900` | The lifetime of the pass, from 1 to 86400 seconds. |
| `nowMs` | `Date.now()` | The issue time, in epoch milliseconds. |
| `budgets` | `[]` | The budgets. Each action of a budget must be in the scope. |

`issuePass` returns `{ reference, expiresAt, scope, proofs, budgets }`.
`expiresAt` is in epoch milliseconds. All proofs have the same timestamp.
See [SPEC.md](../SPEC.md#pass-response) for the format.

### Scope

| Export | Description |
|---|---|
| `normalizeScope(list)` | Checks a list of action keys. Returns the keys in normal form, without duplicates. The list must have 1 action or more. |
| `inScope(scope, method, path)` | Returns `true` if the scope permits the method and the path. It ignores the query string. It never throws. |
| `parseAction(key)` | Returns `{ method, path }` for an action key. |
| `parseMethodPath(method, path)` | Returns `{ method, path }` in normal form, or `null` if the input is not valid. It never throws. |

### Budgets

A budget is `{ name, actions, limit, windowSeconds, per }`. See [budgets.md](budgets.md#budget-fields).

| Export | Description |
|---|---|
| `MAX_WINDOW_SECONDS` | `86400`. The longest budget window. |
| `validateBudgets(budgets, scope?)` | Checks the budgets. Returns copies in normal form. If you give the scope, each action of a budget must be in the scope. |
| `checkBudgets(store, input)` | Checks each budget that covers the action. It does not write to the store. |
| `recordUse(store, input)` | Counts 1 use in each budget that covers the action. |
| `checkAndRecordUse(store, input)` | Checks the budgets, and counts the request only if all budgets have room. The Worker adapter uses this function. |
| `rateLimitHeaders(applied)` | Returns the `RateLimit-Policy` and `RateLimit` headers for the `applied` list. If the list is empty, it returns `{}`. |

The `input` of the 3 store functions is `{ budgets, method, path, reference, sessionKey, nowMs }`.
`nowMs` is optional. The default is `Date.now()`.
A budget with `per: 'pass'` needs `reference`. A budget with `per: 'session'` needs `sessionKey`.

`checkBudgets` and `checkAndRecordUse` return 1 of these results:

```js
{ ok: true, applied }
{ ok: false, code: 'budget', budget, retryAfter, applied }
```

| Field | Meaning |
|---|---|
| `applied` | 1 item for each budget that covers the action, the strictest budget first. |
| `budget` | The name of the budget that has no room. If more than 1 budget has no room, it is the budget with the longest wait. |
| `retryAfter` | The number of seconds until that budget has room. |

Each `applied` item is `{ name, limit, windowSeconds, remaining, resetSeconds }`.
`remaining` is the room after this request. `resetSeconds` is the time until the window starts again.

If the store has the method `addUsesIfRoom`, `checkAndRecordUse` checks and counts in 1 step.
Then 2 requests at the same time cannot both use the last room in a budget.
If the store does not have the method, `checkAndRecordUse` calls `checkBudgets` and then `recordUse`.

### Activity

| Export | Description |
|---|---|
| `activityEvent(input)` | Returns an activity event: `{ at, lane, action, status, code, pass }`. |
| `logLine(event)` | Returns 1 JSON line for a log: the event fields and `"type": "agentlane.activity"`. |

The `input` of `activityEvent` is `{ at, reference, action, status, code }`.
The event keeps only the first 8 characters of the reference, in `pass`.
It never keeps the full reference, the proof, the session key or the request body.
`lane` is always `'agent'`. `code` is `null` when the request succeeds.

### Stores

| Export | Description |
|---|---|
| `MemoryStore` | A store in memory. It keeps the data of each session apart. Use it for tests and local development only. |
| `createMemoryStore(options?)` | Returns a new `MemoryStore`. |
| `memoryStores(options?)` | Returns `(env, sessionKey) => store`, with 1 `MemoryStore` for each session key. Use it as the `store` option of `withAgentLane`. |

`MemoryStore` options:

| Option | Default | Meaning |
|---|---|---|
| `keepActivity` | `200` | The number of newest activity events to keep for each session. |
| `keepPasses` | `10` | The number of passes to keep for each session. The store keeps the passes that expire last. |
| `keepUsesMs` | `86400000` (1 day) | `prune` removes budget uses that are older than this. |

A store has these async methods:

| Method | Description |
|---|---|
| `putPass({ referenceHash, sessionKey, expiresAt })` | Keeps a pass. |
| `getPass(referenceHash)` | Returns `{ sessionKey, expiresAt }` or `null`. It does not check the time. |
| `countUses(key, sinceMs)` | Returns the number of uses of the key with a time after `sinceMs`. |
| `addUse(key, atMs)` | Adds 1 use of the key. |
| `addUsesIfRoom(entries, atMs)` | Optional. `entries` is `[{ key, sinceMs, limit }]`. Counts the uses of each key. If each count is less than its limit, it adds 1 use to each key. It returns the counts from before the add. The count and the add must be 1 step. |
| `prune(nowMs)` | Removes expired passes and old uses. |
| `logActivity(event, { sessionKey })` | Adds 1 event to the activity log of the session. |
| `listActivity({ sessionKey, limit })` | Returns the events of the session, newest first. |

A store can hold the data of many sessions. Then it must keep the sessions apart.
`listActivity` returns only the events that `logActivity` got with the same `sessionKey`.
The store limits the number of passes for each session, not for all sessions together.

`MemoryStore` and `AgentLaneStore` have all these methods, and they follow these rules.
If you write a store, add `addUsesIfRoom`. Without it, requests at the same time can go over a budget by a small number.

## Cloudflare

| Export | Description |
|---|---|
| `withAgentLane(handler, options)` | Wraps the Worker's `fetch` handler and preserves its `scheduled`, `queue`, `email`, `tail`, `tailStream` and `trace` handlers, including their original `this`. See [cloudflare.md](cloudflare.md#options) for the options. |
| `AgentLaneStore` | The Durable Object class of the store. Export it from the Worker module and bind it as `AGENTLANE`. |
| `SqlAgentLaneStore` | The store logic over a SQL interface like `ctx.storage.sql`. `AgentLaneStore` uses it. |
| `wafRules(options)` | Returns the edge rules as Cloudflare WAF custom rules. See below. |
| `orderedRules(rules)` | Returns all rules from `wafRules` in 1 list, in the order that the ruleset needs: the block rules first. |
| `DEFAULT_HEADERS` | `{ reference: 'X-Agent-Session', proof: 'X-Agent-Proof' }`. |
| `DEFAULT_PASS_LIMIT` | `{ limit: 5, windowSeconds: 30 }`. The default limit on pass requests for each session. |
| `PASS_BUDGET_NAME` | `'agentlane.pass'`. The name of the budget that limits pass requests. |
| `MIN_SECRET_BYTES` | `32`. The shortest secret that `withAgentLane` accepts, in bytes. With a shorter secret, the pass request and the lane requests get HTTP 503. |

The entry point `@nekuda/webmcp-agentlane/cloudflare/waf` exports `wafRules`, `orderedRules`, `DEFAULT_HEADERS` and `MAX_EXPRESSION_LENGTH` (`4096`).

`wafRules` options:

| Option | Default | Meaning |
|---|---|---|
| `host` | Required | The host name of the site in lower case, for example `"example.com"`. |
| `secret` | Required | The secret of the Worker. Printable ASCII without spaces, double quotes or backslashes. |
| `scope` | Required | The action keys. Use the same scope as the Worker. |
| `ttlSeconds` | `900` | The lifetime of a proof. Use the same value as the Worker. |
| `headers` | `DEFAULT_HEADERS` | The names of the lane headers. Use the same names as the Worker. |
| `label` | `'Agent lane'` | The start of each rule description. |
| `origin` | None | The origin of the site, for example `"https://example.com"`. If you set it, the result also has a skip rule for the pass request. |
| `passPath` | `'/agentlane/pass'` | The path of the pass request. The function uses it only with `origin`. |

`wafRules` returns `{ rejectInvalid, skipBotFilterForValid }`.
If you set `origin`, the result also has `skipBotFilterForPass`.
Each rule is `{ description, action, expression, action_parameters, enabled }`. A skip rule also has `logging`.
If a rule expression has more than 4096 characters, the function throws a `RangeError`.

## Browser

### createAgentLaneClient(options?)

Returns a client: `{ fetch(path, init), pass(), clear() }`.

| Option | Default | Meaning |
|---|---|---|
| `passUrl` | `'/agentlane/pass'` | The path of the pass request. |
| `headers` | `{ reference: 'X-Agent-Session', proof: 'X-Agent-Proof' }` | The names of the lane headers. |
| `refreshMarginMs` | `5000` | Get a new pass when the current pass has less time left than this. |
| `fetchImpl` | `globalThis.fetch` | The fetch function. Use it for tests. |

| Method | Description |
|---|---|
| `fetch(path, init?)` | Sends 1 tool request through the agent lane. It has the same arguments as `fetch()`. It returns the `Response`, also for HTTP 429. |
| `pass()` | Returns the current pass, or gets a new pass. The pass object is frozen. |
| `clear()` | Forgets the pass. Use it when the person signs out. |

`fetch` has these rules:

- The path must be on the origin of the page, for example `/api/notes`. If it is on another origin, `fetch` throws an `Error`.
- If the action is not in the scope, `fetch` throws `Error('agentlane: action not in scope: <METHOD> <path>')`. It does not send the request.
- `fetch` sends the request with `credentials: 'same-origin'`, `cache: 'no-store'` and `redirect: 'error'`.
- If the response is HTTP 403 with the code `proof` or `pass`, `fetch` gets a new pass and sends the request again 1 time. It does not do this for a body that is a stream.
- After all other responses, `fetch` returns the response. This includes HTTP 401 and other HTTP 403 responses. The site handler can send them after it does the action.
- If the pass request fails, `fetch` and `pass` throw an `Error`. The error has `status`, and `code` and `retryAfter` when the site sends them.

See [SPEC.md](../SPEC.md#client-rules) for all client rules.

### registerTools(tools, options?)

Gives the tools to the WebMCP API of the browser.
It uses `document.modelContext` (W3C WebMCP draft). If that does not exist, it uses `navigator.modelContext` (older Chrome versions).

| Option | Default | Meaning |
|---|---|---|
| `client` | None | The client from `createAgentLaneClient()`. The tools get it as `lane`. |
| `signal` | None | An `AbortSignal`. Abort it to remove all the tools. |
| `exposedTo` | None | A list of origins. The function gives it to the WebMCP option `exposedTo`. |

A tool is `{ name, title?, description, inputSchema?, annotations?, execute }`.

- `name` has 1 to 128 letters, digits, `_`, `.` or `-`. Each name must be different.
- `description` must not be empty.
- The browser calls `execute(input, { lane, signal })`. `lane` is the client. `signal` is the `AbortSignal` of the tool call, if the browser gives one.

`registerTools` returns 1 of these values:

- `false`, if the browser has no WebMCP API.
- A promise that resolves to `true` after the function registers all tools.

If 1 tool fails, the function removes the tools that it registered, and the promise rejects.
If a tool or an option is not valid, the function throws a `TypeError` immediately.

The module also exports `DEFAULT_HEADERS`.
