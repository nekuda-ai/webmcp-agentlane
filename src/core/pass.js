// Issue a pass.
//
// A pass is a short-lived permission that the site gives to the page for
// tool requests. It has a random reference, a scope, one proof for each
// action in the scope, and the budgets that apply to it.
//
// The site sends the pass to the page once. The server keeps only the hash
// of the reference (see hashReference), never the reference itself.

import { DEFAULT_TTL_SECONDS, checkTtl, hex, sha256Hex, signProof } from './proof.js';
import { normalizeScope, parseAction } from './scope.js';
import { validateBudgets } from './budget.js';

// Return a new reference: 32 random bytes as 64 lower-case hex characters.
export function newReference() {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// Return the hash of a reference. Use it as the key of the pass in the store.
export async function hashReference(reference) {
  return sha256Hex(reference);
}

// Issue a pass.
// Returns { reference, expiresAt, scope, proofs, budgets }.
// expiresAt is in epoch milliseconds. All proofs have the same timestamp.
// Throws TypeError if the scope, the budgets or the TTL is not valid.
export async function issuePass({ secret, scope, ttlSeconds = DEFAULT_TTL_SECONDS, nowMs = Date.now(), budgets = [] } = {}) {
  checkTtl(ttlSeconds);
  if (!Number.isFinite(nowMs)) throw new TypeError('agentlane: nowMs must be a number of milliseconds.');
  const actions = normalizeScope(scope);
  const publicBudgets = validateBudgets(budgets, actions);

  const reference = newReference();
  const timestamp = Math.floor(nowMs / 1000);
  const entries = await Promise.all(
    actions.map(async (action) => {
      const { method, path } = parseAction(action);
      return [action, await signProof(secret, reference, method, path, timestamp)];
    }),
  );

  return {
    reference,
    expiresAt: (timestamp + ttlSeconds) * 1000,
    scope: actions,
    proofs: Object.fromEntries(entries),
    budgets: publicBudgets,
  };
}
