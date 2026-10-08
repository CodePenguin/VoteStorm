import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { STORM_CODE_LENGTH, generateStormCode, normalizeStormCode, hashResultsKey } from '../../lib/stormCode.js';

describe('stormCode', () => {
  it('generateStormCode returns 8 base32 characters and differs between calls', () => {
    const a = generateStormCode();
    const b = generateStormCode();
    expect(STORM_CODE_LENGTH).toBe(8);
    expect(a).toHaveLength(8);
    expect(a).toMatch(/^[A-Z2-7]{8}$/);
    expect(a).not.toBe(b);
  });

  it('normalizeStormCode uppercases and strips spaces and hyphens', () => {
    expect(normalizeStormCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeStormCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normalizeStormCode(' abcd efgh ')).toBe('ABCDEFGH');
  });

  it('normalizeStormCode returns an empty string for non-strings', () => {
    expect(normalizeStormCode(undefined)).toBe('');
    expect(normalizeStormCode(42)).toBe('');
  });

  it('hashResultsKey is sha256 of the prefixed key', () => {
    expect(hashResultsKey('x')).toBe(createHash('sha256').update('results:x').digest('hex'));
  });
});
