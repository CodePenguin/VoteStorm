import { DEFAULT_MAX_WORDS, MAX_MAX_WORDS } from './words.js';

// One set of rules for cloud text and shape, used when a cloud is created and when it is edited.
export const CLOUD_KINDS = ['choice', 'rating', 'words', 'content'];
export const MAX_BODY_LENGTH = 4000;
export const MAX_OPTION_LENGTH = 100;
export const MAX_OPTIONS = 20;
export const MAX_SCALE_VALUES = 20;

/** Returns { error } for bad input, or { value } with everything cleaned and ready to store. */
export function normalizeCloudInput(input = {}) {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) return { error: 'The cloud needs some text' };
  if (body.length > MAX_BODY_LENGTH) return { error: `The text can be at most ${MAX_BODY_LENGTH} characters` };
  if (!CLOUD_KINDS.includes(input.kind)) return { error: 'Invalid cloud kind' };

  const value = {
    kind: input.kind,
    body,
    options: null,
    scaleMin: null,
    scaleMax: null,
    multi: 0,
    correct: null,
    display: 'bars',
    resultsHidden: input.resultsHidden ? 1 : 0,
    maxWords: null,
  };

  if (input.kind === 'choice') {
    const options = Array.isArray(input.options) ? input.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (options.length < 2) return { error: 'At least two options are required' };
    if (options.length > MAX_OPTIONS) return { error: `A question can have at most ${MAX_OPTIONS} options` };
    if (options.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: `Each option can be at most ${MAX_OPTION_LENGTH} characters` };
    value.options = options;
    value.multi = input.multi ? 1 : 0;
    value.display = input.display === 'donut' ? 'donut' : 'bars';
    const picked = Array.isArray(input.correct) ? input.correct.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length) : [];
    value.correct = picked.length ? JSON.stringify([...new Set(picked)].sort((a, b) => a - b)) : null;
  } else if (input.kind === 'content') {
    value.resultsHidden = 0;
  } else if (input.kind === 'words') {
    const maxWords = input.maxWords === undefined ? DEFAULT_MAX_WORDS : input.maxWords;
    if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > MAX_MAX_WORDS) return { error: 'Words per person must be a whole number from 1 to 10' };
    value.maxWords = maxWords;
  } else {
    value.scaleMin = Number.isInteger(input.scaleMin) ? input.scaleMin : 1;
    value.scaleMax = Number.isInteger(input.scaleMax) ? input.scaleMax : 5;
    if (value.scaleMin >= value.scaleMax) return { error: 'Scale max must be greater than min' };
    if (value.scaleMax - value.scaleMin + 1 > MAX_SCALE_VALUES) return { error: `A rating scale can have at most ${MAX_SCALE_VALUES} values` };
  }
  return { value };
}
