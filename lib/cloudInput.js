import { DEFAULT_MAX_WORDS, MAX_MAX_WORDS } from './words.js';
import { MAX_VOTING_SECONDS } from './cloud.js';

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

  // Any kind can have a timer: its length, and whether it starts by itself when the cloud comes live (only with a length).
  const timerSeconds = input.timerSeconds ?? null;
  if (timerSeconds !== null && !(Number.isInteger(timerSeconds) && timerSeconds >= 1 && timerSeconds <= MAX_VOTING_SECONDS)) {
    return { error: `The timer must be a whole number of seconds from 1 to ${MAX_VOTING_SECONDS}` };
  }
  // Each correct answer is read as a number below, which throws on some objects: only a list of numbers is taken.
  const correct = input.correct ?? null;
  if (correct !== null && (!Array.isArray(correct) || correct.some((n) => typeof n !== 'number'))) {
    return { error: 'The correct answers must be a list of option numbers' };
  }

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
    timerSeconds,
    timerAuto: timerSeconds !== null && input.timerAuto === true ? 1 : 0,
  };

  if (input.kind === 'choice') {
    // Each option is turned into text below, which throws on some objects: only a list of text is taken.
    if (input.options != null && (!Array.isArray(input.options) || input.options.some((o) => typeof o !== 'string'))) return { error: 'The options must be a list of text' };
    const options = Array.isArray(input.options) ? input.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (options.length < 2) return { error: 'At least two options are required' };
    if (options.length > MAX_OPTIONS) return { error: `A question can have at most ${MAX_OPTIONS} options` };
    if (options.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: `Each option can be at most ${MAX_OPTION_LENGTH} characters` };
    value.options = options;
    value.multi = input.multi ? 1 : 0;
    value.display = input.display === 'donut' ? 'donut' : 'bars';
    const picked = correct ? correct.filter((n) => Number.isInteger(n) && n >= 0 && n < options.length) : [];
    value.correct = picked.length ? JSON.stringify([...new Set(picked)].sort((a, b) => a - b)) : null;
  } else if (input.kind === 'content') {
    value.resultsHidden = 0;
  } else if (input.kind === 'words') {
    // One rule for number fields: left out or null takes the default; anything else must be a whole number in range.
    const maxWords = input.maxWords ?? DEFAULT_MAX_WORDS;
    if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > MAX_MAX_WORDS) return { error: 'Words per person must be a whole number from 1 to 10' };
    value.maxWords = maxWords;
  } else {
    value.scaleMin = input.scaleMin ?? 1;
    value.scaleMax = input.scaleMax ?? 5;
    if (!Number.isInteger(value.scaleMin) || !Number.isInteger(value.scaleMax)) return { error: 'Scale min and max must be whole numbers' };
    if (value.scaleMin >= value.scaleMax) return { error: 'Scale max must be greater than min' };
    if (value.scaleMax - value.scaleMin + 1 > MAX_SCALE_VALUES) return { error: `A rating scale can have at most ${MAX_SCALE_VALUES} values` };
  }
  return { value };
}
