import { describe, it, expect } from 'vitest';
import { normalizeCloudInput, MAX_BODY_LENGTH } from '../../lib/cloudInput.js';

describe('normalizeCloudInput: word clouds', () => {
  it('defaults to 3 words per person and keeps the body', () => {
    const { value } = normalizeCloudInput({ kind: 'words', body: 'One word for today' });
    expect(value).toMatchObject({ kind: 'words', body: 'One word for today', maxWords: 3, options: null, resultsHidden: 0 });
  });
  it('takes 1 to 10 words per person and honours hiding results', () => {
    expect(normalizeCloudInput({ kind: 'words', body: 'x', maxWords: 10, resultsHidden: true }).value).toMatchObject({ maxWords: 10, resultsHidden: 1 });
    for (const bad of [0, 11, 2.5, '3', null]) {
      expect(normalizeCloudInput({ kind: 'words', body: 'x', maxWords: bad }).error).toBe('Words per person must be a whole number from 1 to 10');
    }
  });
});

describe('normalizeCloudInput: content clouds', () => {
  it('needs only a body, and stores no options, scale or answer', () => {
    const { value, error } = normalizeCloudInput({ kind: 'content', body: '  > A quote  ' });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ kind: 'content', body: '> A quote', options: null, scaleMin: null, scaleMax: null, multi: 0, correct: null, display: 'bars', resultsHidden: 0, maxWords: null });
  });
  it('ignores results-hiding, options and correct answers sent with it', () => {
    const { value } = normalizeCloudInput({ kind: 'content', body: 'Hi', resultsHidden: true, options: ['a', 'b'], correct: [0] });
    expect(value.resultsHidden).toBe(0);
    expect(value.options).toBeNull();
    expect(value.correct).toBeNull();
  });
  it('refuses an empty body, a body over the limit and an unknown kind', () => {
    expect(normalizeCloudInput({ kind: 'content', body: '   ' }).error).toBe('The cloud needs some text');
    expect(normalizeCloudInput({ kind: 'content', body: 'x'.repeat(MAX_BODY_LENGTH + 1) }).error).toMatch(/at most 4000/);
    expect(normalizeCloudInput({ kind: 'poem', body: 'Hi' }).error).toBe('Invalid cloud kind');
  });
});
