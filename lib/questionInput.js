// One set of rules for question text and shape, used when a question is created and when it is edited.
export const MAX_PROMPT_LENGTH = 300;
export const MAX_OPTION_LENGTH = 100;
export const MAX_OPTIONS = 20;
export const MAX_SCALE_VALUES = 20;

/** Returns { error } for bad input, or { value } with everything cleaned and ready to store. */
export function normalizeQuestionInput(input = {}) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return { error: 'A prompt is required' };
  if (prompt.length > MAX_PROMPT_LENGTH) return { error: `The prompt can be at most ${MAX_PROMPT_LENGTH} characters` };
  if (input.type !== 'choice' && input.type !== 'rating') return { error: 'Invalid question type' };

  const value = {
    type: input.type,
    prompt,
    options: null,
    scaleMin: null,
    scaleMax: null,
    multi: 0,
    correct: null,
    display: 'bars',
    resultsHidden: input.resultsHidden ? 1 : 0,
  };

  if (input.type === 'choice') {
    const options = Array.isArray(input.options) ? input.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (options.length < 2) return { error: 'At least two options are required' };
    if (options.length > MAX_OPTIONS) return { error: `A question can have at most ${MAX_OPTIONS} options` };
    if (options.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: `Each option can be at most ${MAX_OPTION_LENGTH} characters` };
    value.options = options;
    value.multi = input.multi ? 1 : 0;
    value.display = input.display === 'donut' ? 'donut' : 'bars';
    const picked = Array.isArray(input.correct) ? input.correct.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length) : [];
    value.correct = picked.length ? JSON.stringify([...new Set(picked)].sort((a, b) => a - b)) : null;
  } else {
    value.scaleMin = Number.isInteger(input.scaleMin) ? input.scaleMin : 1;
    value.scaleMax = Number.isInteger(input.scaleMax) ? input.scaleMax : 5;
    if (value.scaleMin >= value.scaleMax) return { error: 'Scale max must be greater than min' };
    if (value.scaleMax - value.scaleMin + 1 > MAX_SCALE_VALUES) return { error: `A rating scale can have at most ${MAX_SCALE_VALUES} values` };
  }
  return { value };
}
