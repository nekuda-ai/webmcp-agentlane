// Budgets over a store, and RateLimit response headers.
//
// A budget is a limit on how many tool requests the agent lane accepts in a
// time window:
//
//   { name, actions: [actionKey] | '*', limit, windowSeconds, per: 'pass' | 'session' }
//
// - actions: the actions that the budget covers. '*' covers all actions.
// - limit: the number of requests in one window. A whole number, 1 or more.
// - windowSeconds: the length of the window. A whole number from 1 to 86400.
// - per: 'pass' counts the requests of each pass. 'session' counts the
//   requests of all passes of the same person's session. The default is 'session'.
//
// Windows are fixed. A window starts at a whole multiple of windowSeconds
// after the Unix epoch. Thus every count has an exact reset time, and the
// RateLimit headers can tell the agent the exact wait.
//
// Use checkAndRecordUse for each request. It checks the budgets and counts
// the request in 1 step. You can also use checkBudgets before the request,
// and recordUse only if the check passes. checkBudgets never writes to the
// store.
//
// Store interface (memory-store.js implements it):
//   async countUses(key, sinceMs) -> number of uses with atMs > sinceMs
//   async addUse(key, atMs)
//   async addUsesIfRoom(entries, atMs) -> counts      (optional)
//     entries: [{ key, sinceMs, limit }]. The store counts the uses of each
//     key with atMs > sinceMs. If each count is less than its limit, the
//     store adds 1 use to each key. It does the count and the add in 1 step,
//     so 2 requests at the same time cannot both use the last room.
//     It returns the counts from before the add.

import { sha256Hex } from './proof.js';
import { actionKey, normalizeScope } from './scope.js';

export const MAX_WINDOW_SECONDS = 86400;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PER_VALUES = ['pass', 'session'];

function budgetError(index, text) {
  return new TypeError(`agentlane: budget ${index + 1}: ${text}`);
}

// Validate a list of budgets and return copies in normal form.
// If you give the scope, every action of a budget must be in the scope.
// Throws TypeError if a budget is not valid.
export function validateBudgets(budgets, scope) {
  if (budgets === undefined || budgets === null) return [];
  if (!Array.isArray(budgets)) throw new TypeError('agentlane: budgets must be a list.');
  const names = new Set();
  return budgets.map((budget, index) => {
    if (!budget || typeof budget !== 'object') throw budgetError(index, 'it must be an object.');
    const { name, actions, limit, windowSeconds, per = 'session' } = budget;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw budgetError(index, 'the name must have 1 to 64 letters, digits, "_", "." or "-".');
    }
    if (names.has(name)) throw budgetError(index, `2 budgets have the name "${name}". Give each budget a different name.`);
    names.add(name);

    let keys;
    if (actions === '*') {
      keys = '*';
    } else {
      if (!Array.isArray(actions) || actions.length === 0) {
        throw budgetError(index, `"${name}" must list 1 action or more, or use "*".`);
      }
      keys = normalizeScope(actions);
      if (scope) {
        const missing = keys.filter((key) => !scope.includes(key));
        if (missing.length > 0) {
          throw budgetError(index, `"${name}" covers actions that are not in the scope: ${missing.join(', ')}.`);
        }
      }
    }

    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw budgetError(index, `the limit of "${name}" must be a whole number, 1 or more.`);
    }
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
      throw budgetError(index, `windowSeconds of "${name}" must be a whole number from 1 to ${MAX_WINDOW_SECONDS}.`);
    }
    if (!PER_VALUES.includes(per)) {
      throw budgetError(index, `per of "${name}" must be "pass" or "session".`);
    }
    return { name, actions: keys === '*' ? '*' : [...keys], limit, windowSeconds, per };
  });
}

// Return the budgets that cover the action, in configuration order.
function covering(budgets, action) {
  return budgets.filter((budget) => budget.actions === '*' || budget.actions.includes(action));
}

// Return a function that gives the store key for each budget.
// The key holds a hash of the reference or of the session key, never the value itself.
async function keyMaker(list, { reference, sessionKey }) {
  const needPass = list.some((budget) => budget.per === 'pass');
  const needSession = list.some((budget) => budget.per === 'session');
  if (needPass && (typeof reference !== 'string' || reference === '')) {
    throw new TypeError('agentlane: a budget with per "pass" needs the reference.');
  }
  if (needSession && (typeof sessionKey !== 'string' || sessionKey === '')) {
    throw new TypeError('agentlane: a budget with per "session" needs the session key.');
  }
  const passHash = needPass ? await sha256Hex(reference) : null;
  const sessionHash = needSession ? await sha256Hex(sessionKey) : null;
  return (budget) => `budget:${budget.name}:${budget.per}:${budget.per === 'pass' ? passHash : sessionHash}`;
}

function windowOf(budget, nowMs) {
  const windowMs = budget.windowSeconds * 1000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const resetSeconds = Math.max(1, Math.ceil((startMs + windowMs - nowMs) / 1000));
  return { startMs, resetSeconds };
}

// Sort the strictest budget first: the least room, then the longest wait.
// The sort is stable, so equal budgets keep configuration order.
function strictestFirst(list) {
  return [...list].sort((a, b) => a.remaining - b.remaining || b.resetSeconds - a.resetSeconds);
}

// Check every budget that covers the action. This function does not write to the store.
// Returns { ok: true, applied } or { ok: false, code: 'budget', budget, retryAfter, applied }.
// applied: [{ name, limit, windowSeconds, remaining, resetSeconds }], strictest first.
// remaining is the room that stays after this request. If the check passes, the
// count includes this request. If the check fails, the count does not include it.
// If more than 1 budget has no room, budget and retryAfter come from the budget
// with the longest wait, because the request needs room in all budgets.
export async function checkBudgets(store, { budgets, method, path, reference, sessionKey, nowMs = Date.now() } = {}) {
  const list = covering(validateBudgets(budgets), actionKey(method, path));
  if (list.length === 0) return { ok: true, applied: [] };
  const keyFor = await keyMaker(list, { reference, sessionKey });

  const results = await Promise.all(
    list.map(async (budget) => {
      const { startMs, resetSeconds } = windowOf(budget, nowMs);
      // countUses counts uses with atMs > sinceMs. The window starts at startMs.
      const used = await store.countUses(keyFor(budget), startMs - 1);
      return { budget, used, resetSeconds };
    }),
  );
  return summarize(results);
}

// Make the result of a budget check from the count of each budget.
function summarize(results) {
  const blocked = results.filter((result) => result.used >= result.budget.limit);
  const ok = blocked.length === 0;
  const applied = strictestFirst(
    results.map(({ budget, used, resetSeconds }) => ({
      name: budget.name,
      limit: budget.limit,
      windowSeconds: budget.windowSeconds,
      remaining: Math.max(0, budget.limit - used - (ok ? 1 : 0)),
      resetSeconds,
    })),
  );
  if (ok) return { ok: true, applied };

  let worst = blocked[0];
  for (const result of blocked) if (result.resetSeconds > worst.resetSeconds) worst = result;
  return { ok: false, code: 'budget', budget: worst.budget.name, retryAfter: worst.resetSeconds, applied };
}

// Count one use in every budget that covers the action.
// Call this function only after checkBudgets returns ok: true.
export async function recordUse(store, { budgets, method, path, reference, sessionKey, nowMs = Date.now() } = {}) {
  const list = covering(validateBudgets(budgets), actionKey(method, path));
  if (list.length === 0) return;
  const keyFor = await keyMaker(list, { reference, sessionKey });
  await Promise.all(list.map((budget) => store.addUse(keyFor(budget), nowMs)));
}

// Check every budget that covers the action, and count the request if all
// budgets have room. Returns the same result as checkBudgets.
// If the store has addUsesIfRoom, the store does the check and the count in
// 1 step. Then requests at the same time cannot go over a limit.
// If the store does not have it, the function calls checkBudgets and then
// recordUse. Then requests at the same time can go over a limit by a small number.
export async function checkAndRecordUse(store, input = {}) {
  if (!store || typeof store.addUsesIfRoom !== 'function') {
    const check = await checkBudgets(store, input);
    if (check.ok) await recordUse(store, input);
    return check;
  }
  const { budgets, method, path, reference, sessionKey, nowMs = Date.now() } = input;
  const list = covering(validateBudgets(budgets), actionKey(method, path));
  if (list.length === 0) return { ok: true, applied: [] };
  const keyFor = await keyMaker(list, { reference, sessionKey });

  const windows = list.map((budget) => ({ budget, key: keyFor(budget), ...windowOf(budget, nowMs) }));
  const counts = await store.addUsesIfRoom(
    windows.map(({ budget, key, startMs }) => ({ key, sinceMs: startMs - 1, limit: budget.limit })),
    nowMs,
  );
  if (!Array.isArray(counts) || counts.length !== windows.length || !counts.every(Number.isSafeInteger)) {
    throw new Error('agentlane: addUsesIfRoom must return 1 count for each entry.');
  }
  return summarize(
    windows.map(({ budget, resetSeconds }, index) => ({ budget, used: counts[index], resetSeconds })),
  );
}

// Write a name as a structured-field string (RFC 8941).
function sfString(value) {
  return `"${String(value).replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

// Return RateLimit headers for the applied budgets, in the style of the IETF
// draft draft-ietf-httpapi-ratelimit-headers:
//   RateLimit-Policy: "<name>";q=<limit>;w=<windowSeconds>
//   RateLimit: "<name>";r=<remaining>;t=<resetSeconds>
// The strictest budget is first. A comma and a space separate the entries.
// Returns {} if no budget applies.
export function rateLimitHeaders(applied) {
  if (!Array.isArray(applied) || applied.length === 0) return {};
  const list = strictestFirst(applied);
  return {
    'RateLimit-Policy': list
      .map((item) => `${sfString(item.name)};q=${item.limit}${item.windowSeconds ? `;w=${item.windowSeconds}` : ''}`)
      .join(', '),
    RateLimit: list.map((item) => `${sfString(item.name)};r=${item.remaining};t=${item.resetSeconds}`).join(', '),
  };
}
