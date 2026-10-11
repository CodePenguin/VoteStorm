import { describe, it, expect } from 'vitest';
import { MAX_VOTING_SECONDS } from '../../lib/cloud.js';
import { MAX_TIMER_SECONDS, blankForm, buildCloudPayload, firstLine, formatDuration, formFromCloud, kindLabel, parseHiddenWords, phaseText, statusLabel, timerNote, toPrivateCloud } from '@/lib/presenter';
import type { AdminCloud } from '@/shared/types';

const row: AdminCloud = {
  id: 3, storm_code: 'R', order_index: 0, kind: 'choice', body: 'Pick', options: JSON.stringify(['Red', 'Green', 'Blue']),
  scale_min: null, scale_max: null, multi: 1, results_hidden: 1, answer_shown: 0, correct: JSON.stringify([1, 2]), display: 'donut',
  timer_seconds: null, timer_auto: 0,
  tally: { counts: [0, 0, 0], totalVotes: 0 },
};

describe('presenter helpers', () => {
  it('offers the same longest timer the server takes', () => {
    expect(MAX_TIMER_SECONDS).toBe(MAX_VOTING_SECONDS);
  });

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

  it('sends null for an emptied scale end, so the server takes its default rather than refusing it', () => {
    const payload = buildCloudPayload({ ...blankForm(), kind: 'rating', body: 'Rate', scaleMin: '' as unknown as number, scaleMax: 7 });
    expect(payload).toMatchObject({ scaleMin: null, scaleMax: 7 });
  });

  it('round-trips a stored cloud into the edit form', () => {
    expect(formFromCloud(row)).toEqual({
      kind: 'choice', body: 'Pick', optionsText: 'Red, Green, Blue', correctText: 'Green, Blue', display: 'donut',
      resultsHidden: true, multi: true, scaleMin: 1, scaleMax: 5, maxWords: 3, timerMode: 'none', timerSeconds: 60,
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

describe('cloud timer helpers', () => {
  it('adds the timer to any kind of payload only when one is set, and checks its length', () => {
    expect(buildCloudPayload({ ...blankForm(), kind: 'content', body: 'C', timerMode: 'auto', timerSeconds: 120 })).toEqual({ kind: 'content', body: 'C', timerSeconds: 120, timerAuto: true });
    expect(buildCloudPayload({ ...blankForm(), kind: 'rating', body: 'R', timerMode: 'manual', timerSeconds: 30 })).toMatchObject({ timerSeconds: 30, timerAuto: false });
    expect(buildCloudPayload({ ...blankForm(), kind: 'content', body: 'C', timerMode: 'none', timerSeconds: 30 })).toEqual({ kind: 'content', body: 'C' });
    for (const bad of [0, 3601, 2.5, '' as unknown as number]) {
      expect(() => buildCloudPayload({ ...blankForm(), kind: 'content', body: 'C', timerMode: 'manual', timerSeconds: bad })).toThrow(/3600/);
    }
  });

  it('reads a stored timer into the form', () => {
    expect(formFromCloud({ ...row, timer_seconds: 120, timer_auto: 1 })).toMatchObject({ timerMode: 'auto', timerSeconds: 120 });
    expect(formFromCloud({ ...row, timer_seconds: 45, timer_auto: 0 })).toMatchObject({ timerMode: 'manual', timerSeconds: 45 });
    expect(formFromCloud(row)).toMatchObject({ timerMode: 'none', timerSeconds: 60 });
  });

  it('writes durations and the timer note compactly', () => {
    expect([15, 60, 90, 120, 300, 3600].map(formatDuration)).toEqual(['15s', '1m', '1m 30s', '2m', '5m', '60m']);
    expect(timerNote({ timer_seconds: 120, timer_auto: 1 } as AdminCloud)).toBe('2m, auto');
    expect(timerNote({ timer_seconds: 45, timer_auto: 0 } as AdminCloud)).toBe('45s');
    expect(timerNote({ timer_seconds: null, timer_auto: 0 } as AdminCloud)).toBeNull();
  });
});
