// Sign and verify proofs.
//
// A proof is a signature that shows the site issued the pass for one action.
// The code uses Web Crypto only (globalThis.crypto). It runs in Cloudflare
// Workers, in browsers and in Node.js 22.
//
// Wire format (compatible with tableforagents.com and with the Cloudflare
// function is_timed_hmac_valid_v0):
//
//   message = UTF-8 bytes of `${reference}:${METHOD}:${path}${unixSeconds}`
//   mac     = HMAC-SHA256(secret, message), encoded as standard base64
//   proof   = `${unixSeconds}-${encodeURIComponent(mac)}`
//
// There is no separator between the path and the seconds. The edge builds
// the same message with concat(reference, ":METHOD:", path, "?verify=", proof)
// and a separator length of 8.

import { actionKey, parseMethodPath } from './scope.js';

export { actionKey };

export const REFERENCE_PATTERN = /^[a-f0-9]{64}$/;
export const PROOF_PATTERN = /^(\d{10})-((?:[A-Za-z0-9]|%2B|%2F){43}%3D)$/;
export const DEFAULT_TTL_SECONDS = 900;
export const MAX_TTL_SECONDS = 86400;

const encoder = new TextEncoder();

function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error('agentlane: Web Crypto (globalThis.crypto.subtle) is not available.');
  return value;
}

// Make an HMAC-SHA256 key from the secret.
// The secret can be a string, bytes or a CryptoKey for HMAC-SHA256.
export async function importSecret(secret) {
  if (typeof CryptoKey !== 'undefined' && secret instanceof CryptoKey) return secret;
  let raw;
  if (typeof secret === 'string') raw = encoder.encode(secret);
  else if (secret instanceof Uint8Array) raw = secret;
  else if (secret instanceof ArrayBuffer) raw = new Uint8Array(secret);
  if (!raw || raw.byteLength === 0) {
    throw new TypeError('agentlane: the secret must be a string or bytes, and it must not be empty.');
  }
  return subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Return bytes as lower-case hex characters.
export function hex(bytes) {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

// Return the SHA-256 hash of a string as 64 lower-case hex characters.
export async function sha256Hex(value) {
  if (typeof value !== 'string') throw new TypeError('agentlane: the value to hash must be a string.');
  return hex(new Uint8Array(await subtle().digest('SHA-256', encoder.encode(value))));
}

function message(reference, method, path, unixSeconds) {
  return encoder.encode(`${reference}:${method}:${path}${unixSeconds}`);
}

function toBase64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function isUnixSeconds(value) {
  // The proof format needs exactly 10 digits.
  return Number.isSafeInteger(value) && value >= 1_000_000_000 && value <= 9_999_999_999;
}

// Check the time to live of a pass, in seconds. Throws TypeError if it is not valid.
export function checkTtl(ttlSeconds) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new TypeError(`agentlane: ttlSeconds must be a whole number from 1 to ${MAX_TTL_SECONDS}.`);
  }
  return ttlSeconds;
}

// Sign the proof for one action. Returns `${unixSeconds}-${encoded MAC}`.
// Throws TypeError if an input is not valid.
export async function signProof(secret, reference, method, path, unixSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    throw new TypeError('agentlane: the reference must be 64 lower-case hex characters.');
  }
  const parsed = parseMethodPath(method, path);
  if (!parsed) {
    throw new TypeError(`agentlane: the action is not valid: ${String(method)} ${String(path)}.`);
  }
  if (!isUnixSeconds(unixSeconds)) {
    throw new TypeError('agentlane: unixSeconds must be a whole number of seconds with 10 digits.');
  }
  const key = await importSecret(secret);
  const mac = await subtle().sign('HMAC', key, message(reference, parsed.method, parsed.path, unixSeconds));
  return `${unixSeconds}-${encodeURIComponent(toBase64(new Uint8Array(mac)))}`;
}

const fail = (reason) => ({ ok: false, code: 'proof', reason });

// Verify the proof for one action at one time.
// Returns { ok: true } or { ok: false, code: 'proof', reason }.
// The reason is 'format', 'future', 'expired' or 'signature'.
// The reference, the method, the path and the proof come from the request.
// Bad values in them never cause an exception. A bad secret or a bad option
// causes a TypeError, because it is a configuration error.
// A proof is valid when timestamp <= now and timestamp + ttl > now.
export async function verifyProof(secret, reference, method, path, proof, options = {}) {
  const { nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = DEFAULT_TTL_SECONDS } = options;
  checkTtl(ttlSeconds);
  if (!Number.isSafeInteger(nowSeconds)) throw new TypeError('agentlane: nowSeconds must be a whole number.');
  const key = await importSecret(secret);

  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) return fail('format');
  const parsed = parseMethodPath(method, path);
  if (!parsed) return fail('format');
  const match = typeof proof === 'string' ? PROOF_PATTERN.exec(proof) : null;
  if (!match) return fail('format');

  const timestamp = Number(match[1]);
  if (timestamp > nowSeconds) return fail('future');
  if (timestamp + ttlSeconds <= nowSeconds) return fail('expired');

  // The pattern permits only base64 characters and %2B, %2F, %3D.
  // Thus decodeURIComponent and atob cannot throw here.
  const encoded = decodeURIComponent(match[2]);
  const binary = atob(encoded);
  const signature = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // Accept only the one canonical encoding of each MAC.
  if (toBase64(signature) !== encoded) return fail('format');

  // crypto.subtle.verify compares the MAC in constant time.
  const valid = await subtle().verify(
    'HMAC',
    key,
    signature,
    message(reference, parsed.method, parsed.path, timestamp),
  );
  return valid ? { ok: true } : fail('signature');
}
