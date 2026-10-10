import { describe, it, expect } from 'vitest';
import { computeChoiceTally, computeRatingTally, computeTally } from '../../lib/tally.js';

describe('computeTally for content clouds', () => {
  it('gives a content cloud an empty tally', () => {
    expect(computeTally({ kind: 'content' }, [])).toEqual({ counts: [], totalVotes: 0 });
  });
});

describe('computeChoiceTally', () => {
  it('counts votes per option', () => {
    const votes = [{ value: '0' }, { value: '1' }, { value: '0' }];
    expect(computeChoiceTally(votes, ['A', 'B'])).toEqual({ counts: [2, 1], totalVotes: 3 });
  });

  it('returns zero counts with no votes', () => {
    expect(computeChoiceTally([], ['A', 'B'])).toEqual({ counts: [0, 0], totalVotes: 0 });
  });

  it('ignores out-of-range values', () => {
    const votes = [{ value: '5' }, { value: '0' }];
    expect(computeChoiceTally(votes, ['A', 'B'])).toEqual({ counts: [1, 0], totalVotes: 2 });
  });
});

describe('computeRatingTally', () => {
  it('counts per value and computes an average', () => {
    const votes = [{ value: '3' }, { value: '5' }, { value: '5' }];
    const result = computeRatingTally(votes, 1, 5);
    expect(result.totalVotes).toBe(3);
    expect(result.average).toBeCloseTo(13 / 3);
    expect(result.counts[5]).toBe(2);
  });

  it('average is null with no votes', () => {
    const result = computeRatingTally([], 1, 5);
    expect(result.totalVotes).toBe(0);
    expect(result.average).toBeNull();
  });
});

describe('computeTally', () => {
  it('dispatches to choice tally', () => {
    const cloud = { kind: 'choice', options: JSON.stringify(['A', 'B']) };
    const result = computeTally(cloud, [{ value: '1' }]);
    expect(result.counts).toEqual([0, 1]);
  });

  it('dispatches to rating tally', () => {
    const cloud = { kind: 'rating', scale_min: 1, scale_max: 5 };
    const result = computeTally(cloud, [{ value: '4' }]);
    expect(result.counts[4]).toBe(1);
  });

  it('throws on an unknown kind', () => {
    expect(() => computeTally({ kind: 'nope' }, [])).toThrow();
  });
});
