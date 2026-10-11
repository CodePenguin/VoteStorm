import { describe, it, expect } from 'vitest';
import { normalizeCloudInput, MAX_BODY_LENGTH } from '../../lib/cloudInput.js';

describe('normalizeCloudInput: word clouds', () => {
  it('defaults to 3 words per person and keeps the body', () => {
    const { value } = normalizeCloudInput({ kind: 'words', body: 'One word for today' });
    expect(value).toMatchObject({ kind: 'words', body: 'One word for today', maxWords: 3, options: null, resultsHidden: 0 });
  });
  it('takes 1 to 10 words per person and honours hiding results', () => {
    expect(normalizeCloudInput({ kind: 'words', body: 'x', maxWords: 10, resultsHidden: true }).value).toMatchObject({ maxWords: 10, resultsHidden: 1 });
    for (const bad of [0, 11, 2.5, '3', Infinity, NaN, true]) {
      expect(normalizeCloudInput({ kind: 'words', body: 'x', maxWords: bad }).error).toBe('Words per person must be a whole number from 1 to 10');
    }
  });
  it('takes the default for a null words-per-person, as when it is left out', () => {
    expect(normalizeCloudInput({ kind: 'words', body: 'x', maxWords: null }).value).toMatchObject({ maxWords: 3 });
  });
});

describe('normalizeCloudInput: rating clouds', () => {
  it('takes the 1 to 5 default for a scale end left out or null', () => {
    expect(normalizeCloudInput({ kind: 'rating', body: 'x' }).value).toMatchObject({ scaleMin: 1, scaleMax: 5 });
    expect(normalizeCloudInput({ kind: 'rating', body: 'x', scaleMin: null, scaleMax: null }).value).toMatchObject({ scaleMin: 1, scaleMax: 5 });
    expect(normalizeCloudInput({ kind: 'rating', body: 'x', scaleMin: 0, scaleMax: null }).value).toMatchObject({ scaleMin: 0, scaleMax: 5 });
  });
  it('refuses a scale end that is not a whole number, as words per person does', () => {
    for (const bad of ['1', 1.5, Infinity, -Infinity, NaN, true, [1], {}]) {
      expect(normalizeCloudInput({ kind: 'rating', body: 'x', scaleMin: bad, scaleMax: 5 }).error).toBeTruthy();
      expect(normalizeCloudInput({ kind: 'rating', body: 'x', scaleMin: 1, scaleMax: bad }).error).toBeTruthy();
    }
  });
});

describe('normalizeCloudInput: choice options', () => {
  it('refuses options that are not a list of text, without throwing', () => {
    for (const bad of [[JSON.parse('{"toString":null}'), 'B'], [{}, 'B'], 'AB', ['A', 2], {}]) {
      expect(normalizeCloudInput({ kind: 'choice', body: 'x', options: bad }).error).toBe('The options must be a list of text');
    }
    expect(normalizeCloudInput({ kind: 'choice', body: 'x', options: [' A ', 'B', ''] }).value.options).toEqual(['A', 'B']);
  });
});

describe('normalizeCloudInput: correct answers', () => {
  it('keeps the valid option numbers, sorted and without repeats', () => {
    expect(normalizeCloudInput({ kind: 'choice', body: 'x', options: ['A', 'B', 'C'], correct: [2, 0, 2, 9, 1.5] }).value.correct).toBe('[0,2]');
    expect(normalizeCloudInput({ kind: 'choice', body: 'x', options: ['A', 'B'], correct: null }).value.correct).toBeNull();
  });
  it('refuses correct answers that are not a list of numbers, without throwing', () => {
    for (const bad of ['0', 0, {}, [JSON.parse('{"toString":null}')], ['1'], [null]]) {
      expect(normalizeCloudInput({ kind: 'choice', body: 'x', options: ['A', 'B'], correct: bad }).error).toBeTruthy();
    }
  });
});

describe('normalizeCloudInput: timer', () => {
  it('has no timer unless asked, for every kind', () => {
    for (const input of [{ kind: 'choice', body: 'Q', options: ['A', 'B'] }, { kind: 'rating', body: 'Q' }, { kind: 'words', body: 'Q' }, { kind: 'content', body: 'Q' }]) {
      expect(normalizeCloudInput(input).value).toMatchObject({ timerSeconds: null, timerAuto: 0 });
    }
  });
  it('keeps a timer of 1 to 3600 seconds on any kind, auto only when asked with true', () => {
    expect(normalizeCloudInput({ kind: 'content', body: 'Q', timerSeconds: 120, timerAuto: true }).value).toMatchObject({ timerSeconds: 120, timerAuto: 1 });
    expect(normalizeCloudInput({ kind: 'words', body: 'Q', timerSeconds: 1 }).value).toMatchObject({ timerSeconds: 1, timerAuto: 0 });
    expect(normalizeCloudInput({ kind: 'rating', body: 'Q', timerSeconds: 3600, timerAuto: 'yes' }).value).toMatchObject({ timerSeconds: 3600, timerAuto: 0 });
  });
  it('ignores auto-start without seconds', () => {
    expect(normalizeCloudInput({ kind: 'content', body: 'Q', timerSeconds: null, timerAuto: true }).value).toMatchObject({ timerSeconds: null, timerAuto: 0 });
  });
  it('refuses seconds outside 1 to 3600 or not whole numbers', () => {
    for (const bad of [0, -5, 3601, 1.5, '60', true, [60], {}]) {
      expect(normalizeCloudInput({ kind: 'content', body: 'Q', timerSeconds: bad }).error).toMatch(/3600/);
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
