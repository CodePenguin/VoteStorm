import { describe, it, expect } from 'vitest';
import { MAX_SIZE_FACTOR, lightClean, stableOrder, wordScale } from '@/lib/wordCloud';

describe('wordScale', () => {
  it('grows with the count and never passes the maximum factor', () => {
    const sizes = [1, 2, 3, 5, 10].map((c) => wordScale(c, 1, 10));
    expect(sizes[0]).toBe(1);
    expect(sizes[4]).toBe(MAX_SIZE_FACTOR);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });
  it('is gentle: half the top count is well above half the way up', () => {
    expect(wordScale(5, 1, 9)).toBeGreaterThan(1 + (MAX_SIZE_FACTOR - 1) * 0.5);
  });
  it('gives equal counts one middling size', () => {
    expect(wordScale(3, 3, 3)).toBe(2);
  });
});

describe('stableOrder', () => {
  it('does not depend on the counts or the input order', () => {
    const a = stableOrder([{ word: 'one', count: 1 }, { word: 'two', count: 5 }, { word: 'three', count: 3 }]).map((w) => w.word);
    const b = stableOrder([{ word: 'three', count: 9 }, { word: 'one', count: 9 }, { word: 'two', count: 1 }]).map((w) => w.word);
    expect(a).toEqual(b);
  });
  it('keeps every word and does not change the input', () => {
    const input = [{ word: 'x' }, { word: 'y' }, { word: 'z' }];
    expect(stableOrder(input)).toHaveLength(3);
    expect(input.map((w) => w.word)).toEqual(['x', 'y', 'z']);
  });
});

describe('lightClean', () => {
  it('trims, collapses spaces and lower-cases', () => {
    expect(lightClean('  Team   WORK ')).toBe('team work');
    expect(lightClean('')).toBe('');
  });
});
