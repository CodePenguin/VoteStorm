import { describe, it, expect } from 'vitest';
import { blankForm, buildQuestionPayload, formFromQuestion, statusLabel, toPrivateQuestion } from '@/lib/presenter';
import type { AdminQuestion } from '@/shared/types';

const row: AdminQuestion = {
  id: 3, room_code: 'R', order_index: 0, type: 'choice', prompt: 'Pick', options: JSON.stringify(['Red', 'Green', 'Blue']),
  scale_min: null, scale_max: null, multi: 1, results_hidden: 1, answer_shown: 0, correct: JSON.stringify([1, 2]), display: 'donut',
  tally: { counts: [0, 0, 0], totalVotes: 0 },
};

describe('presenter helpers', () => {
  it('maps typed correct answers to option indexes, ignoring case and spacing', () => {
    const payload = buildQuestionPayload({ ...blankForm(), prompt: 'Pick', optionsText: ' Red , Green,Blue ', correctText: 'green, BLUE', multi: true, display: 'donut', resultsHidden: true });
    expect(payload).toEqual({ type: 'choice', prompt: 'Pick', resultsHidden: true, options: ['Red', 'Green', 'Blue'], multi: true, display: 'donut', correct: [1, 2] });
  });

  it('omits correct when none is typed and rejects an answer that is not an option', () => {
    expect(buildQuestionPayload({ ...blankForm(), prompt: 'p', optionsText: 'A, B' }).correct).toBeUndefined();
    expect(() => buildQuestionPayload({ ...blankForm(), prompt: 'p', optionsText: 'A, B', correctText: 'C' })).toThrow('Correct answer "C" is not one of the options');
  });

  it('builds a rating payload from the scale', () => {
    expect(buildQuestionPayload({ ...blankForm(), type: 'rating', prompt: 'Rate', scaleMin: 1, scaleMax: 10 })).toEqual({
      type: 'rating', prompt: 'Rate', resultsHidden: false, scaleMin: 1, scaleMax: 10,
    });
  });

  it('round-trips a stored question into the edit form', () => {
    expect(formFromQuestion(row)).toEqual({
      type: 'choice', prompt: 'Pick', optionsText: 'Red, Green, Blue', correctText: 'Green, Blue', display: 'donut',
      resultsHidden: true, multi: true, scaleMin: 1, scaleMax: 5,
    });
  });

  it('gives the presenter an unhidden view with the correct answer', () => {
    const q = toPrivateQuestion(row);
    expect(q).toMatchObject({ resultsHidden: false, correct: [1, 2], options: ['Red', 'Green', 'Blue'], multi: true, display: 'donut' });
  });

  it('labels room statuses', () => {
    expect(statusLabel('active')).toBe('Live');
    expect(statusLabel('lobby')).toBe('Lobby');
    expect(statusLabel('closed')).toBe('Closed');
  });
});
