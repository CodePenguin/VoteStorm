import { describe, it, expect } from 'vitest';
import { cleanWord, cleanWordList, computeWordsTally, parseHiddenWords, MAX_TALLY_WORDS } from '../../lib/words.js';

describe('cleanWord', () => {
  it.each([
    ['Teamwork!', 'teamwork'],
    ['  TEAM   work  ', 'team work'],
    ['"quoted"', 'quoted'],
    ['...hello...', 'hello'],
    ['Été', 'été'],
    ['你好', '你好'],
    ['\u{1F680}', '\u{1F680}'],
    ['rock-n-roll', 'rock-n-roll'],
    ['$100', '100'],
    ['', ''],
    ['   ', ''],
    ['!!!', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(cleanWord(input)).toBe(expected);
  });
  it('returns an empty string for anything that is not text', () => {
    expect(cleanWord(undefined)).toBe('');
    expect(cleanWord(42)).toBe('');
    expect(cleanWord(null)).toBe('');
  });
});

describe('cleanWordList', () => {
  it('cleans each entry and counts a repeat once', () => {
    expect(cleanWordList(['Team', 'team!', ' Work '], 3)).toEqual({ words: ['team', 'work'] });
  });
  it('drops entries that clean to nothing but refuses a list with no words left', () => {
    expect(cleanWordList(['hi', '!!!'], 3)).toEqual({ words: ['hi'] });
    expect(cleanWordList(['!!!', ' '], 3).error).toBe('Enter at least one word');
    expect(cleanWordList([], 3).error).toBe('Enter at least one word');
  });
  it('refuses more words than the cloud allows, after cleaning', () => {
    expect(cleanWordList(['a', 'b', 'c', 'd'], 3).error).toBe('You can send at most 3 words');
    expect(cleanWordList(['a', 'A', 'b'], 2)).toEqual({ words: ['a', 'b'] });
    expect(cleanWordList(['a', 'b'], 1).error).toBe('You can send at most 1 word');
  });
  it('refuses an entry over 30 characters instead of cutting it', () => {
    expect(cleanWordList(['x'.repeat(30)], 3)).toEqual({ words: ['x'.repeat(30)] });
    expect(cleanWordList(['x'.repeat(31)], 3).error).toBe('A word can be at most 30 characters');
  });
  it('counts characters, not bytes, so an emoji is one', () => {
    expect(cleanWordList(['\u{1F680}'.repeat(30)], 3).words).toHaveLength(1);
    expect(cleanWordList(['\u{1F680}'.repeat(31)], 3).error).toMatch(/at most 30/);
  });
  it('refuses a value that is not a list of text, and an absurdly long list', () => {
    expect(cleanWordList('hello', 3).error).toBe('Send a list of words');
    expect(cleanWordList([1, 2], 3).error).toBe('Each word must be text');
    expect(cleanWordList(Array(51).fill('a'), 3).error).toBe('Send a list of words');
  });
});

describe('blank-looking and unusual input', () => {
  const blanks = ['​', '́', 'ㅤ', '⠀', '­', '️'];
  it.each(blanks.map((b) => [JSON.stringify(b), b]))('drops the blank entry %s', (_, blank) => {
    expect(cleanWord(blank)).toBe('');
    expect(cleanWordList([blank], 10).error).toBe('Enter at least one word');
  });
  it('refuses a list of only blank entries', () => {
    expect(cleanWordList(blanks, 10).error).toBe('Enter at least one word');
  });
  it('keeps the zero-width non-joiner inside a Persian word (half-space) but drops it at the edges and when alone', () => {
    const persian = 'می‌خواهم';
    expect(cleanWord(persian)).toBe(persian);
    expect(cleanWord(`‌${persian}‌`)).toBe(persian);
    expect(cleanWord(`!‌${persian}‌!`)).toBe(persian);
    expect(cleanWord('می‌‌خواهم')).toBe(persian);
    expect(cleanWord('‌')).toBe('');
    expect(cleanWord('a ‌ b')).toBe('a b');
    expect(cleanWordList(['‌'], 3).error).toBe('Enter at least one word');
  });
  it('keeps emoji, including joined sequences and variation selectors', () => {
    expect(cleanWord('\u{1F680}')).toBe('\u{1F680}');
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(cleanWord(family)).toBe(family);
    expect(cleanWordList([family], 3)).toEqual({ words: [family] });
    expect(cleanWord('❤️')).toBe('❤️');
  });
  it('removes invisible characters inside a real word', () => {
    expect(cleanWord('te​am')).toBe('team');
  });
  it('cleans composed and decomposed forms to the same word', () => {
    expect(cleanWord('Café')).toBe('café');
    expect(cleanWord('Café')).toBe('café');
  });
  it('handles a long punctuation run inside a word in linear time', () => {
    const started = Date.now();
    const text = 'x' + '! '.repeat(40000) + 'x';
    expect(cleanWord(text).startsWith('x')).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it('refuses an enormous entry quickly', () => {
    const started = Date.now();
    expect(cleanWordList(['x' + '! '.repeat(1000000) + 'x'], 3).error).toBe('A word can be at most 30 characters');
    expect(cleanWordList(['x'.repeat(201)], 3).error).toBe('A word can be at most 30 characters');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('computeWordsTally', () => {
  const vote = (...words) => ({ value: JSON.stringify(words) });
  it('counts people, not entries, and sorts by count then alphabetically', () => {
    const tally = computeWordsTally([vote('b', 'a'), vote('a'), vote('c', 'a'), vote('b')]);
    expect(tally).toEqual({ words: [{ word: 'a', count: 3 }, { word: 'b', count: 2 }, { word: 'c', count: 1 }], totalVotes: 4 });
  });
  it('leaves out hidden words but still counts the people who sent them', () => {
    const tally = computeWordsTally([vote('rude', 'nice'), vote('rude')], ['rude']);
    expect(tally).toEqual({ words: [{ word: 'nice', count: 1 }], totalVotes: 2 });
  });
  it('ignores a row whose value is not a list', () => {
    expect(computeWordsTally([{ value: 'garbage' }, { value: '3' }, vote('ok')])).toEqual({ words: [{ word: 'ok', count: 1 }], totalVotes: 1 });
  });
  it('keeps only the top 100 words', () => {
    const votes = Array.from({ length: 120 }, (_, i) => vote(`w${String(i).padStart(3, '0')}`));
    const tally = computeWordsTally(votes);
    expect(tally.words).toHaveLength(MAX_TALLY_WORDS);
    expect(tally.totalVotes).toBe(120);
  });
  it('has no words when nobody has sent any', () => {
    expect(computeWordsTally([])).toEqual({ words: [], totalVotes: 0 });
  });
});

describe('parseHiddenWords', () => {
  it('reads the stored JSON list and tolerates nothing or garbage', () => {
    expect(parseHiddenWords({ hidden_words: '["a","b"]' })).toEqual(['a', 'b']);
    expect(parseHiddenWords({ hidden_words: null })).toEqual([]);
    expect(parseHiddenWords({ hidden_words: 'nope' })).toEqual([]);
    expect(parseHiddenWords({})).toEqual([]);
  });
});
