// Actions and scope checks.
//
// An action is one HTTP method and one exact path, for example
// "POST /api/reservations". The scope is the list of actions that a pass
// permits. The lane does not support path patterns, because each action
// needs its own proof.

const METHOD_PATTERN = /^[A-Z]{1,16}$/;
// A path starts with "/". It has no spaces, no query string and no fragment.
const PATH_PATTERN = /^\/[^\s?#]*$/;
const MAX_PATH_LENGTH = 512;

// Remove the query string and the fragment from a path.
function stripQuery(path) {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

// Return { method, path } in normal form, or null if the input is not valid.
// This function never throws.
export function parseMethodPath(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const m = method.trim().toUpperCase();
  const p = stripQuery(path.trim());
  if (!METHOD_PATTERN.test(m)) return null;
  if (p.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(p)) return null;
  return { method: m, path: p };
}

// Return the action key for a method and a path, for example "POST /api/x".
// The function changes the method to upper-case and removes the query string.
// Throws TypeError if the method or the path is not valid.
export function actionKey(method, path) {
  const parsed = parseMethodPath(method, path);
  if (!parsed) {
    throw new TypeError(
      `agentlane: the action is not valid: ${String(method)} ${String(path)}. ` +
        'Use an HTTP method and a path that starts with "/".',
    );
  }
  return `${parsed.method} ${parsed.path}`;
}

// Return { method, path } for an action key. Throws TypeError if the key is not valid.
export function parseAction(key) {
  if (typeof key !== 'string') {
    throw new TypeError('agentlane: an action must be a string, for example "POST /api/reservations".');
  }
  const parts = key.trim().split(/\s+/);
  if (parts.length !== 2 || /[?#]/.test(parts[1])) {
    throw new TypeError(
      `agentlane: the action is not valid: "${key}". ` +
        'Use one method, one space and one path without a query string.',
    );
  }
  const parsed = parseMethodPath(parts[0], parts[1]);
  if (!parsed) {
    throw new TypeError(
      `agentlane: the action is not valid: "${key}". ` +
        'Use one method, one space and one path without a query string.',
    );
  }
  return parsed;
}

// Validate a list of actions and return the action keys in normal form.
// The function removes duplicates and keeps the first order.
// Throws TypeError if the list is empty or if an action is not valid.
export function normalizeScope(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('agentlane: the scope must be a list with 1 action or more.');
  }
  const keys = [];
  for (const item of list) {
    const { method, path } = parseAction(item);
    const key = `${method} ${path}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Return true if the scope permits this method and path. This function never throws.
export function inScope(scope, method, path) {
  if (!Array.isArray(scope)) return false;
  const parsed = parseMethodPath(method, path);
  if (!parsed) return false;
  return scope.includes(`${parsed.method} ${parsed.path}`);
}
