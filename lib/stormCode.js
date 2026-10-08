import { createHash, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STORM_CODE_LENGTH = 8;

// The code is only an identifier; the signature is what protects a Storm. 256 is a multiple of 32, so no modulo bias.
export function generateStormCode() {
  let code = '';
  for (const byte of randomBytes(STORM_CODE_LENGTH)) code += BASE32_ALPHABET[byte % 32];
  return code;
}

/** Uppercase with spaces and hyphens removed, so `abcd-efgh` and `ABCD EFGH` are the same code. */
export function normalizeStormCode(text) {
  return typeof text === 'string' ? text.toUpperCase().replace(/[\s-]/g, '') : '';
}

// Only the hash of the results key is stored (for lookup); the browser derives the key from the admin secret.
export function hashResultsKey(resultsKey) {
  return createHash('sha256').update('results:' + resultsKey).digest('hex');
}
