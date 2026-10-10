import { describe, it, expect } from 'vitest';
import {
  countFor, donutSegments, emptyTally, formatAverage, hasCounts, isHiddenTally, isLeader, normalizeTally, pctFor, ratingValues, responsesLabel,
  isWordsTally, wordsOf,
} from '@/lib/tally';

describe('words tally helpers', () => {
  it('tells a words tally from a counts tally', () => {
    expect(isWordsTally({ words: [], totalVotes: 0 })).toBe(true);
    expect(isWordsTally({ counts: [1], totalVotes: 1 })).toBe(false);
    expect(isWordsTally(null)).toBe(false);
  });
  it('returns the words, or an empty list for anything else', () => {
    const words = [{ word: 'hi', count: 2 }];
    expect(wordsOf({ words, totalVotes: 2 })).toEqual(words);
    expect(wordsOf(null)).toEqual([]);
    expect(wordsOf({ counts: [1], totalVotes: 1 })).toEqual([]);
    expect(wordsOf({ hidden: true, totalVotes: 1 })).toEqual([]);
  });
});

describe('tally helpers', () => {
  it('counts and percentages for a choice tally', () => {
    const t = { counts: [3, 1, 0], totalVotes: 4 };
    expect(countFor(t, 0)).toBe(3);
    expect(countFor(t, 2)).toBe(0);
    expect(pctFor(t, 0)).toBe(75);
    expect(pctFor(t, 1)).toBe(25);
    expect(pctFor({ counts: [], totalVotes: 0 }, 0)).toBe(0);
  });

  it('works on rating tallies keyed by value, and finds the leader', () => {
    const t = { counts: { 1: 0, 2: 5, 3: 2 }, totalVotes: 7, average: 2.3 };
    expect(countFor(t, 2)).toBe(5);
    expect(isLeader(t, 2)).toBe(true);
    expect(isLeader(t, 3)).toBe(false);
    expect(isLeader(t, 1)).toBe(false);
  });

  it('builds the rating scale, and none when the scale is missing', () => {
    expect(ratingValues({ scaleMin: 1, scaleMax: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(ratingValues({ scaleMin: null, scaleMax: null })).toEqual([]);
  });

  it('lays donut segments end to end around the circle', () => {
    const segs = donutSegments([1, 3]);
    expect(segs[0]).toEqual({ dash: 25, offset: -0 });
    expect(segs[1]).toEqual({ dash: 75, offset: -25 });
    expect(donutSegments([0, 0])).toEqual([{ dash: 0, offset: -0 }, { dash: 0, offset: -0 }]);
  });

  it('recognises hidden tallies and normalises a missing one', () => {
    expect(isHiddenTally({ totalVotes: 2, hidden: true })).toBe(true);
    expect(isHiddenTally({ counts: [], totalVotes: 0 })).toBe(false);
    expect(hasCounts({ totalVotes: 2, hidden: true })).toBe(false);
    expect(normalizeTally(null)).toEqual(emptyTally());
  });

  it('formats averages and response labels', () => {
    expect(formatAverage(null)).toBe('–');
    expect(formatAverage(3.456)).toBe('3.5');
    expect(responsesLabel(1)).toBe('response');
    expect(responsesLabel(0)).toBe('responses');
  });
});
