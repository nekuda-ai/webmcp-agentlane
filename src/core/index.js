// Core of the agent lane. It has no runtime dependencies and uses Web Crypto
// only, so it runs in Cloudflare Workers, in browsers and in Node.js 22.

export {
  REFERENCE_PATTERN,
  PROOF_PATTERN,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  actionKey,
  importSecret,
  sha256Hex,
  signProof,
  verifyProof,
} from './proof.js';
export { newReference, hashReference, issuePass } from './pass.js';
export { normalizeScope, inScope, parseAction, parseMethodPath } from './scope.js';
export {
  MAX_WINDOW_SECONDS,
  validateBudgets,
  checkBudgets,
  recordUse,
  checkAndRecordUse,
  rateLimitHeaders,
} from './budget.js';
export { activityEvent, logLine } from './activity.js';
export { MemoryStore, createMemoryStore, memoryStores } from './memory-store.js';
