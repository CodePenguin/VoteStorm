import { describe, it, expect } from 'vitest';
import { buildStormFile, parseStormFile, readStormFileText, stormFileText, MAX_IMPORT_CLOUDS } from '../../lib/stormFile.js';

const row = (over = {}) => ({
  kind: 'choice', body: 'Pick', options: '["A","B"]', scale_min: null, scale_max: null, multi: 0, display: 'bars',
  results_hidden: 0, correct: null, max_words: null, timer_seconds: null, timer_auto: 0, ...over,
});
const file = (over = {}) => ({ votestorm: 1, name: 'Town hall', resultsBackground: '#1e293b', clouds: [], ...over });
const cloud = (over = {}) => ({ kind: 'choice', body: 'Pick', options: ['A', 'B'], ...over });

describe('Storm file', () => {
  it('exports every field in a fixed order, with nothing from the session', () => {
    const built = buildStormFile({
      name: 'Town hall',
      resultsBackground: '#1e293b',
      clouds: [
        { ...row({ multi: 1, display: 'donut', results_hidden: 1, correct: '[1]', timer_seconds: 120, timer_auto: 1 }), id: 9, storm_code: 'ABCDEFGH', hidden_words: '["x"]', closes_at: 5, tally: { counts: [1, 2], totalVotes: 3 } },
        row({ kind: 'rating', options: null, scale_min: 1, scale_max: 5, display: null }),
        row({ kind: 'words', options: null, max_words: 4, display: null }),
        row({ kind: 'content', options: null, display: null, timer_seconds: 30 }),
      ],
    });
    expect(built).toEqual({
      votestorm: 1,
      name: 'Town hall',
      resultsBackground: '#1e293b',
      clouds: [
        { kind: 'choice', body: 'Pick', options: ['A', 'B'], scaleMin: null, scaleMax: null, multi: true, display: 'donut', resultsHidden: true, correct: [1], maxWords: null, timerSeconds: 120, timerAuto: true },
        { kind: 'rating', body: 'Pick', options: null, scaleMin: 1, scaleMax: 5, multi: false, display: 'bars', resultsHidden: false, correct: null, maxWords: null, timerSeconds: null, timerAuto: false },
        { kind: 'words', body: 'Pick', options: null, scaleMin: null, scaleMax: null, multi: false, display: 'bars', resultsHidden: false, correct: null, maxWords: 4, timerSeconds: null, timerAuto: false },
        { kind: 'content', body: 'Pick', options: null, scaleMin: null, scaleMax: null, multi: false, display: 'bars', resultsHidden: false, correct: null, maxWords: null, timerSeconds: 30, timerAuto: false },
      ],
    });
    expect(Object.keys(built)).toEqual(['votestorm', 'name', 'resultsBackground', 'clouds']);
    expect(Object.keys(built.clouds[0])).toEqual(['kind', 'body', 'options', 'scaleMin', 'scaleMax', 'multi', 'display', 'resultsHidden', 'correct', 'maxWords', 'timerSeconds', 'timerAuto']);
    expect(stormFileText(built)).toBe(`${JSON.stringify(built, null, 2)}\n`);
  });

  it('writes an unnamed Storm with the default background as nulls', () => {
    expect(buildStormFile({ name: null, resultsBackground: null, clouds: [] })).toEqual({ votestorm: 1, name: null, resultsBackground: null, clouds: [] });
  });

  it('reads back exactly what it wrote', () => {
    const built = buildStormFile({ name: 'N', resultsBackground: null, clouds: [row({ correct: '[0]', timer_seconds: 60, timer_auto: 1 }), row({ kind: 'content', options: null })] });
    const read = readStormFileText(stormFileText(built));
    expect(read.error).toBeUndefined();
    expect(read.data).toEqual(built);
    expect(read.value.name).toBe('N');
    expect(read.value.clouds.map((c) => [c.kind, c.timerSeconds, c.timerAuto])).toEqual([['choice', 60, 1], ['content', null, 0]]);
  });

  it('ignores unknown keys and accepts a leading byte-order mark', () => {
    const read = readStormFileText(`\uFEFF${JSON.stringify(file({ exportedBy: 'someone', clouds: [cloud({ votes: 9, id: 3 })] }))}`);
    expect(read.error).toBeUndefined();
    expect(read.value.clouds).toHaveLength(1);
    expect(read.value.clouds[0]).not.toHaveProperty('votes');
  });

  it('refuses what is not a version 1 Storm file', () => {
    for (const data of [null, 42, 'x', [], {}, file({ votestorm: 2 }), file({ votestorm: '1' }), file({ clouds: undefined }), file({ clouds: {} })]) {
      expect(parseStormFile(data).error).toBeTruthy();
    }
    expect(readStormFileText('{ not json').error).toBeTruthy();
    expect(readStormFileText('').error).toBeTruthy();
  });

  it('checks the name and background like the Storm settings do', () => {
    expect(parseStormFile(file({ name: 'x'.repeat(81) })).error).toBeTruthy();
    expect(parseStormFile(file({ name: 7 })).error).toBeTruthy();
    expect(parseStormFile(file({ resultsBackground: 'red' })).error).toBeTruthy();
    expect(parseStormFile(file({ resultsBackground: 'url(x)' })).error).toBeTruthy();
    expect(parseStormFile(file({ name: '  Spaced  ', resultsBackground: '#ABCDEF' })).value).toMatchObject({ name: 'Spaced', resultsBackground: '#abcdef' });
    expect(parseStormFile(file({ name: '', resultsBackground: '' })).value).toMatchObject({ name: null, resultsBackground: null });
  });

  it('names the cloud that is wrong', () => {
    expect(parseStormFile(file({ clouds: [cloud(), cloud(), cloud({ options: ['only one'] })] })).error).toMatch(/^Cloud 3: /);
    expect(parseStormFile(file({ clouds: [cloud(), null] })).error).toMatch(/^Cloud 2: /);
    expect(parseStormFile(file({ clouds: [['choice']] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ options: [{}, 'B'] })] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ correct: JSON.parse('[{"toString":null}]') })] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ correct: '0' })] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ timerSeconds: 7200 })] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ body: 'x'.repeat(4001) })] })).error).toMatch(/^Cloud 1: /);
    expect(parseStormFile(file({ clouds: [cloud({ kind: 'poll' })] })).error).toMatch(/^Cloud 1: /);
  });

  it('treats the number fields of a hand-edited file alike: null takes the default, a wrong type is refused', () => {
    const rating = (over) => cloud({ kind: 'rating', options: null, ...over });
    const words = (over) => cloud({ kind: 'words', options: null, ...over });
    const read = parseStormFile(file({ clouds: [rating({ scaleMin: null, scaleMax: null }), words({ maxWords: null }), rating({}), words({})] }));
    expect(read.error).toBeUndefined();
    expect(read.value.clouds.map((c) => [c.scaleMin, c.scaleMax, c.maxWords])).toEqual([[1, 5, null], [null, null, 3], [1, 5, null], [null, null, 3]]);
    for (const bad of ['1', 1.5, 1e999]) {
      expect(parseStormFile(file({ clouds: [cloud(), rating({ scaleMin: bad })] })).error).toMatch(/^Cloud 2: /);
      expect(parseStormFile(file({ clouds: [cloud(), rating({ scaleMax: bad })] })).error).toMatch(/^Cloud 2: /);
      expect(parseStormFile(file({ clouds: [cloud(), words({ maxWords: bad })] })).error).toMatch(/^Cloud 2: /);
    }
  });

  it('reads back every kind it wrote unchanged', () => {
    const built = buildStormFile({
      name: 'All kinds',
      resultsBackground: '#123456',
      clouds: [
        row({ multi: 1, display: 'donut', correct: '[1]', timer_seconds: 90, timer_auto: 1 }),
        row({ kind: 'rating', options: null, scale_min: -2, scale_max: 2, display: null, timer_seconds: 45 }),
        row({ kind: 'words', options: null, max_words: 7, display: null, results_hidden: 1 }),
        row({ kind: 'content', options: null, display: null }),
      ],
    });
    const { value } = readStormFileText(stormFileText(built));
    const rows = value.clouds.map((c) => row({
      kind: c.kind, body: c.body, options: c.options && JSON.stringify(c.options), scale_min: c.scaleMin, scale_max: c.scaleMax, multi: c.multi,
      display: c.display, results_hidden: c.resultsHidden, correct: c.correct, max_words: c.maxWords, timer_seconds: c.timerSeconds, timer_auto: c.timerAuto,
    }));
    expect(stormFileText(buildStormFile({ name: value.name, resultsBackground: value.resultsBackground, clouds: rows }))).toBe(stormFileText(built));
  });

  it('takes at most 100 clouds', () => {
    const many = (n) => file({ clouds: Array.from({ length: n }, () => cloud()) });
    expect(parseStormFile(many(MAX_IMPORT_CLOUDS)).value.clouds).toHaveLength(100);
    expect(parseStormFile(many(MAX_IMPORT_CLOUDS + 1)).error).toBeTruthy();
  });

  it('is not fooled by prototype keys', () => {
    const read = readStormFileText('{"votestorm":1,"__proto__":{"polluted":true},"clouds":[{"kind":"content","body":"x","__proto__":{"kind":"choice"}}]}');
    expect(read.error).toBeUndefined();
    expect(read.value.clouds[0].kind).toBe('content');
    expect({}.polluted).toBeUndefined();
  });
});
