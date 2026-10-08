import { describe, it, expect } from 'vitest';
import { normalizeStormCode, formatStormCode } from '@/lib/stormCode';

describe('normalizeStormCode', () => {
  it('uppercases and removes spaces and hyphens', () => {
    expect(normalizeStormCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeStormCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normalizeStormCode(' abcd efgh ')).toBe('ABCDEFGH');
  });
});

describe('formatStormCode', () => {
  it('splits an 8-character code in the middle', () => {
    expect(formatStormCode('ABCDEFGH')).toBe('ABCD EFGH');
  });

  it('returns a code of another length unchanged', () => {
    expect(formatStormCode('ABC')).toBe('ABC');
    expect(formatStormCode('ABCDEFGHJ')).toBe('ABCDEFGHJ');
  });
});
