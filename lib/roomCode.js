import { createHash, randomBytes } from 'node:crypto';

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
