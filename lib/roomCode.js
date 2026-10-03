import { createHash, createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateAdminKey() {
  return randomBytes(24).toString('hex');
}

export function hashAdminKey(adminKey) {
  return createHash('sha256').update(adminKey).digest('hex');
}

export function deriveRoomCode(adminKey) {
  const hash = hashAdminKey(adminKey);
  const bytes = Buffer.from(hash, 'hex');
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += BASE32_ALPHABET[bytes[i] % 32];
  }
  return code;
}

// The results key is derived from the secret admin key with a different construction than the room
// code, so it cannot be recomputed from the stored admin_key_hash. Only its hash is stored (for lookup).
export function deriveResultsKey(adminKey) {
  return createHmac('sha256', adminKey).update('votestorm-results').digest('hex').slice(0, 24);
}

export function hashResultsKey(resultsKey) {
  return createHash('sha256').update('results:' + resultsKey).digest('hex');
}
