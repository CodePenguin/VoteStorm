import { describe, it, expect } from 'vitest';
import { retryLabel } from '@/lib/relativeTime';

describe('retryLabel', () => {
  it.each([
    [undefined, 'later'],
    [Number.NaN, 'later'],
    [-5, 'later'],
    [0, 'in under a minute'],
    [59, 'in under a minute'],
    [60, 'in a minute'],
    [61, 'in about 2 minutes'],
    [719, 'in about 12 minutes'],
    [720, 'in about 12 minutes'],
    [3540, 'in about 59 minutes'],
    [3541, 'in about an hour'],
    [3600, 'in about an hour'],
    [3601, 'in about 2 hours'],
  ])('%s seconds -> %s (rounded up, never too early)', (seconds, label) => {
    expect(retryLabel(seconds)).toBe(label);
  });
});
