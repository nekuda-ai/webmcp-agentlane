# Budgets

A budget is a limit on how many tool requests the agent lane accepts in a time window.
This document describes the budget model, a starting set, the count rules and the response headers.
It has instructions for site owners and for agent developers.

## Budget fields

A budget is a plain object:

```js
{ name: 'reads', actions: ['GET /api/restaurants', 'GET /api/reservations'], limit: 20, windowSeconds: 30, per: 'pass' }
```

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The name of the budget. It has 1 to 64 letters, digits, `_`, `.` or `-`. The lane uses the name `agentlane.pass` for the pass limit. Do not use that name. |
| `actions` | array of action keys, or `'*'` | The actions that the budget covers. `'*'` covers all actions in the scope. Each action must be in the scope. |
| `limit` | whole number, 1 or more | The number of requests that the budget accepts in 1 window. |
| `windowSeconds` | whole number, 1 to 86400 | The length of the window, in seconds. |
| `per` | `'pass'` or `'session'` | `'pass'` counts the requests of each pass. `'session'` counts the requests of all passes of the session. The default is `'session'`. Always set it. |

If a budget is not valid, `withAgentLane` throws a `TypeError` when the Worker starts.

## Recommended starting set

Use this set as a starting point. Change the numbers after you read the activity log of your site.

| Budget | Actions | Limit | Window | `per` | Reason |
|---|---|---|---|---|---|
| `reads` | Read actions, for example `GET /api/restaurants` and `GET /api/reservations` | 20 | 30 seconds | `pass` | An agent can search and read some result pages in a short burst. Reads cost the site little. |
| `availability` | Availability lookups, for example `GET /api/availability` | 5 | 30 seconds | `pass` | Lookups often read live inventory, so they cost more. One task usually needs only a few lookups. |
| `writes` | Consequential writes, for example `POST /api/reservations` | 1 | 86400 seconds (1 day) | `session` | A consequential write has a real effect for the person, for example a booking, an order or a payment. A low limit stops loops and duplicates. |
| `session-ceiling` | All actions in the scope (`'*'`) | 60 | 30 seconds | `session` | It limits the total of all passes of the session. See [The pass multiplier](#the-pass-multiplier). |
| `agentlane.pass` (built in) | The pass request | 5 | 30 seconds | `session` | Code in the page cannot get passes without limit. See [The pass limit](#the-pass-limit). |

The live example, tableforagents.com, accepts 1 agent booking for each account.
It does this check in its site handler, not in a lane budget.

The same set as configuration:

```js
budgets: [
  { name: 'reads', actions: ['GET /api/restaurants', 'GET /api/reservations'], limit: 20, windowSeconds: 30, per: 'pass' },
  { name: 'availability', actions: ['GET /api/availability'], limit: 5, windowSeconds: 30, per: 'pass' },
  { name: 'writes', actions: ['POST /api/reservations'], limit: 1, windowSeconds: 86400, per: 'session' },
  { name: 'session-ceiling', actions: '*', limit: 60, windowSeconds: 30, per: 'session' },
],
```

The adapter adds the `agentlane.pass` budget. Set it with the option `passLimit`.

## How the lane counts

The lane counts in check 6 of the server checks. These are the steps:

1. The lane finds each budget that covers the action of the request.
2. The lane counts the requests in the current window of each budget.
3. If a budget has no room, the lane responds with HTTP 429. It does not count the request.
4. If all budgets have room, the lane counts 1 use in each budget. Then it sends the request to the site handler.

These rules follow from the steps:

- A request must have room in all of its budgets.
- The store does the count and the add in 1 step. Thus 2 requests at the same time cannot both use the last room.
- If 2 or more budgets have no room, `Retry-After` comes from the budget with the longest wait.
- A request that fails checks 1 to 5 does not use a budget.
- The lane counts a request before the site handler runs. If the site handler then responds with an error, the request still counts.
- Requests in the human lane never use a budget.

## Windows

Windows are fixed. They do not slide.
A window starts at a whole multiple of `windowSeconds` after the Unix epoch.

- A 30-second window starts at second 0 and second 30 of each minute.
- A 1-day window starts at 00:00 UTC.

Fixed windows let the lane tell the agent the exact time until the window starts again.

This example shows the `availability` budget (5 requests in 30 seconds) for one pass:

| Time (UTC) | Lookup | Response | `RateLimit` header |
|---|---|---|---|
| 08:00:01 | 1 | HTTP 200 | `"availability";r=4;t=29` |
| 08:00:05 | 5 | HTTP 200 | `"availability";r=0;t=25` |
| 08:00:06 | 6 | HTTP 429, `Retry-After: 24` | `"availability";r=0;t=24` |
| 08:00:30 | 7 | HTTP 200 (a new window) | `"availability";r=4;t=30` |

An agent can use the full limit at the end of one window. Then it can use the full limit again at the start of the next window.
Thus, the short peak can be 2 times the limit. Make sure that the site can accept 2 times each limit in a short time.

## Per pass and per session

| `per` | The lane counts | Use it for |
|---|---|---|
| `pass` | The requests of 1 pass | Limits for each agent task, for example reads and lookups |
| `session` | The requests of all passes of the session | Limits on real effects, for example writes, and a ceiling for all agent requests of the session |

The `session` callback of the site returns the session key. The session key decides what "session" means:

- If the callback returns the ID of a login session, each login session has its own budgets. A new sign-in starts with full budgets.
- If the callback returns the ID of an account, all sessions of the account share the budgets. A pass then works in all sessions of that account.

The store and the activity log also use the session key. They follow the same choice.

### The pass multiplier

A budget with `per: 'pass'` does not limit the total for a session. Each new pass starts with full `per: 'pass'` budgets.
Code in the page can get many passes. The pass limit permits 5 passes in 30 seconds. The store keeps 10 passes for each session.
For example, 10 passes with a `reads` budget of 20 can send 200 reads in 30 seconds.

For this reason, the recommended set has a session ceiling. This budget covers all actions in the scope:

```js
{ name: 'session-ceiling', actions: '*', limit: 60, windowSeconds: 30, per: 'session' },
```

The number 60 is an example. Set it above the normal need of one agent task.

## The pass limit

The Worker adapter limits pass requests. By default, it permits 5 passes in 30 seconds for each session.
The limit is a budget with the name `agentlane.pass` and `per: 'session'`.

- To change the limit, set the option `passLimit: { limit, windowSeconds }`.
- To remove the limit, set `passLimit: null`. Do not remove it if you use budgets with `per: 'pass'`.

If the limit has no room, the pass request gets HTTP 429 with the code `budget`.

## Response headers

The lane sends budget information in the style of the
[IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/).
The lane adds the headers to these responses:

- Each response to a tool request that passes all checks.
- Each HTTP 429 response.
- Each pass response, for the pass limit.

The lane adds the headers only if a budget covers the action.
Error responses from the lane with HTTP 401, HTTP 403 or HTTP 503 have no RateLimit headers.

If more than 1 budget covers an action, each header has 1 entry for each budget.
The strictest budget comes first: the budget with the least room, then the budget with the longest wait.

```http
RateLimit-Policy: "availability";q=5;w=30, "session-ceiling";q=60;w=30
RateLimit: "availability";r=4;t=29, "session-ceiling";r=59;t=29
```

| Header | Parameter | Meaning |
|---|---|---|
| `RateLimit-Policy` | `q` | The limit of the budget. |
| `RateLimit-Policy` | `w` | The length of the window, in seconds. |
| `RateLimit` | `r` | The number of requests that the budget still accepts in this window. |
| `RateLimit` | `t` | The number of seconds until the window starts again. |
| `Retry-After` | (seconds) | Only on HTTP 429. The number of seconds to wait. |

The draft also defines the parameters `qu` and `pk`. The lane does not send them.
On a successful response, `r` already includes the current request.

## HTTP 429

If a budget has no room, the server responds with HTTP 429. The site handler does not run.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Retry-After: 24
RateLimit-Policy: "availability";q=5;w=30, "session-ceiling";q=60;w=30
RateLimit: "availability";r=0;t=24, "session-ceiling";r=55;t=24

{"error":"The budget \"availability\" has no room now. Try again in 24 seconds.","code":"budget","budget":"availability","retryAfter":24}
```

| Field | Meaning |
|---|---|
| `error` | A message for people. |
| `code` | Always `budget`. |
| `budget` | The name of the budget that has no room. |
| `retryAfter` | The number of seconds to wait. It is the same as `Retry-After`. |

## For agent developers

The agent lane is the predictable path for your agent. It shows the budgets before your agent starts, and the RateLimit headers show the room left.
The page UI, the [human lane](STYLE.md#glossary), is the hard path. There, the site can use stricter bot protection and human checks, and it can refuse your agent.

Do these steps when your agent uses a site with an agent lane:

1. Read `budgets` in the pass. Plan the task inside the budgets.
2. Read the `RateLimit` header after each request.
3. If `r` is 0 for a budget, wait `t` seconds before the next request to that budget.
4. If you get HTTP 429, wait for the number of seconds in `Retry-After`. Then send the request again.
5. Do not send the same consequential write 2 times. If the site accepts an idempotency key, send one.
6. Do not move to the human lane when a budget is full. The human lane has its own checks, and the site can block the person.

## For site owners: change the budgets

Do these steps after the lane runs on your site:

1. Start with the recommended set.
2. Read the activity log. Look for events with the code `budget`.
3. If agents reach a budget during normal tasks, increase the limit.
4. If the agent lane puts too much load on the site, decrease the limit or add a session ceiling.
5. Keep consequential writes at a low limit.

A change to the budgets applies from the next request. It applies to old passes and to new passes.
Only new passes show the new values in `budgets`.
If you change the name of a budget, its count starts again at 0.

## Storage

The counts are in the store of the session. In the Cloudflare adapter, this is 1 Durable Object for each session.
The store removes counts that are older than 1 day. For this reason, the longest window is 86400 seconds.
For a limit over a longer time, use the logic of your site. tableforagents.com does this for its 1 agent booking for each account.
