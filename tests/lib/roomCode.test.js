import { describe, it, expect } from 'vitest';
import { generateAdminKey, hashAdminKey, deriveRoomCode } from '../../lib/roomCode.js';

describe('roomCode', () => {
  it('derives a 6-character room code deterministically', () => {
    const key = 'test-admin-key-12345';
    const code1 = deriveRoomCode(key);
    const code2 = deriveRoomCode(key);
    expect(code1).toBe(code2);
    expect(code1).toHaveLength(6);
    expect(code1).toMatch(/^[A-Z2-7]+$/);
  });

  it('produces different codes for different keys', () => {
    expect(deriveRoomCode('key-a')).not.toBe(deriveRoomCode('key-b'));
  });

  it('generateAdminKey returns a unique-looking hex string', () => {
    const a = generateAdminKey();
    const b = generateAdminKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
  });

  it('hashAdminKey is deterministic sha256 hex', () => {
    const key = 'abc';
    expect(hashAdminKey(key)).toBe(hashAdminKey(key));
    expect(hashAdminKey(key)).toHaveLength(64);
  });
});
