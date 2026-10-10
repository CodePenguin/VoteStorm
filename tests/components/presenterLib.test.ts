import { describe, it, expect } from 'vitest';
import { blankForm, buildCloudPayload, firstLine, formFromCloud, kindLabel, parseHiddenWords, phaseText, statusLabel, toPrivateCloud } from '@/lib/presenter';
import type { AdminCloud } from '@/shared/types';

const row: AdminCloud = {
  id: 3, storm_code: 'R', order_index: 0, kind: 'choice', body: 'Pick', options: JSON.stringify(['Red', 'Green', 'Blue']),
  scale_min: null, scale_max: null, multi: 1, results_hidden: 1, answer_shown: 0, correct: JSON.stringify([1, 2]), display: 'donut',
  tally: { counts: [0, 0, 0], totalVotes: 0 },
};

describe('presenter helpers', () => {
  it('shows a markdown body as one plain line for the Present list', () => {
    expect(firstLine('**great team**?')).toBe('great team?');
    expect(firstLine('# A well-known [site](https://example.com)\n\nmore')).toBe('A well-known site');
    expect(firstLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });

  it('maps typed correct answers to option indexes, ignoring case and spacing', () => {
    const payload = buildCloudPayload({ ...blankForm(), body: 'Pick', optionsText: ' Red , Green,Blue ', correctText: 'green, BLUE', multi: true, display: 'donut', resultsHidden: true });
    expect(payload).toEqual({ kind: 'choice', body: 'Pick', resultsHidden: true, options: ['Red', 'Green', 'Blue'], multi: true, display: 'donut', correct: [1, 2] });
  });

  it('omits correct when none is typed and rejects an answer that is not an option', () => {
    expect(buildCloudPayload({ ...blankForm(), body: 'p', optionsText: 'A, B' }).correct).toBeUndefined();
    expect(() => buildCloudPayload({ ...blankForm(), body: 'p', optionsText: 'A, B', correctText: 'C' })).toThrow('Correct answer "C" is not one of the options');
  });

  it('sends the default of 3 words per person when the field was left empty', () => {
    const empty = { ...blankForm(), kind: 'words' as const, body: 'Words?', maxWords: '' as unknown as number };
    expect(buildCloudPayload(empty).maxWords).toBe(3);
    expect(buildCloudPayload({ ...empty, maxWords: 5 }).maxWords).toBe(5);
  });

  it('builds a rating payload from the scale', () => {
    expect(buildCloudPayload({ ...blankForm(), kind: 'rating', body: 'Rate', scaleMin: 1, scaleMax: 10 })).toEqual({
      kind: 'rating', body: 'Rate', resultsHidden: false, scaleMin: 1, scaleMax: 10,
    });
  });

  it('round-trips a stored cloud into the edit form', () => {
    expect(formFromCloud(row)).toEqual({
      kind: 'choice', body: 'Pick', optionsText: 'Red, Green, Blue', correctText: 'Green, Blue', display: 'donut',
      resultsHidden: true, multi: true, scaleMin: 1, scaleMax: 5, maxWords: 3,
    });
  });

  it('gives the presenter an unhidden view with the correct answer', () => {
    const q = toPrivateCloud(row);
    expect(q).toMatchObject({ resultsHidden: false, correct: [1, 2], options: ['Red', 'Green', 'Blue'], multi: true, display: 'donut' });
  });

  it('builds a content payload from only its kind and body', () => {
    expect(buildCloudPayload({ ...blankForm(), kind: 'content', body: '> Quote' })).toEqual({ kind: 'content', body: '> Quote' });
  });

  it('builds a words payload with words per person and hiding', () => {
    expect(buildCloudPayload({ ...blankForm(), kind: 'words', body: 'One word', maxWords: 5, resultsHidden: true })).toEqual({ kind: 'words', body: 'One word', maxWords: 5, resultsHidden: true });
  });

  it('round-trips a words and a content cloud through the form', () => {
    const words = { id: 1, kind: 'words', body: 'B', max_words: 4, results_hidden: 1, options: null } as AdminCloud;
    expect(formFromCloud(words)).toMatchObject({ kind: 'words', body: 'B', maxWords: 4, resultsHidden: true });
    expect(formFromCloud({ id: 2, kind: 'content', body: 'C' } as AdminCloud)).toMatchObject({ kind: 'content', body: 'C' });
  });

  it('labels each kind', () => {
    expect(kindLabel({ kind: 'content' } as AdminCloud)).toBe('Content');
    expect(kindLabel({ kind: 'words', max_words: 3 } as AdminCloud)).toBe('Words (up to 3)');
    expect(kindLabel({ kind: 'choice', multi: 1 } as AdminCloud)).toBe('Multi-select');
    expect(kindLabel({ kind: 'rating', scale_min: 1, scale_max: 5 } as AdminCloud)).toBe('Rating 1–5');
  });

  it('says "Time\'s up" for a content cloud and "Voting closed" for a question', () => {
    expect(phaseText('content').closed).toBe("Time's up");
    expect(phaseText('choice').closed).toBe('Voting closed');
    expect(phaseText('words').closed).toBe('Submissions closed');
  });

  it('reads the removed words of a cloud', () => {
    expect(parseHiddenWords({ hidden_words: JSON.stringify(['rude']) } as AdminCloud)).toEqual(['rude']);
    expect(parseHiddenWords({ hidden_words: null } as AdminCloud)).toEqual([]);
  });

  it('labels storm statuses', () => {
    expect(statusLabel('active')).toBe('Live');
    expect(statusLabel('lobby')).toBe('Lobby');
    expect(statusLabel('closed')).toBe('Closed');
  });
});
