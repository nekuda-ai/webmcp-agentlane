// Activity events and log lines.
//
// The activity log is the record of tool requests and their results.
// An event holds the time, the lane, the action, the HTTP status, the error
// code and the first 8 characters of the reference. An event never holds
// the full reference, the proof, the session key or the request body.

import { REFERENCE_PATTERN } from './proof.js';

const MAX_ACTION_LENGTH = 200;
const CODE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// Return the first 8 characters of a valid reference, or null.
function passLabel(reference) {
  return typeof reference === 'string' && REFERENCE_PATTERN.test(reference) ? reference.slice(0, 8) : null;
}

// Make an activity event.
// Returns { at, lane: 'agent', action, status, code, pass }.
// at is in epoch milliseconds. code is null when the request succeeds.
// The input can have a sessionKey. The function does not copy it into the
// event. The store keeps the events of each session apart (1 store for each session).
export function activityEvent({ at = Date.now(), reference, action, status, code = null } = {}) {
  return {
    at: Number.isFinite(at) ? at : Date.now(),
    lane: 'agent',
    action: typeof action === 'string' ? action.slice(0, MAX_ACTION_LENGTH) : null,
    status: Number.isSafeInteger(status) ? status : null,
    code: typeof code === 'string' && CODE_PATTERN.test(code) ? code : null,
    pass: passLabel(reference),
  };
}

// Return one JSON line for console logs. The line has only the event fields,
// so a full reference or a session key can never get into the log.
export function logLine(event) {
  const source = event && typeof event === 'object' ? event : {};
  return JSON.stringify({
    type: 'agentlane.activity',
    at: source.at ?? null,
    lane: source.lane ?? 'agent',
    action: source.action ?? null,
    status: source.status ?? null,
    code: source.code ?? null,
    pass: typeof source.pass === 'string' ? source.pass.slice(0, 8) : null,
  });
}
