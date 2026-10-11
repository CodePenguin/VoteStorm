import { describe, it, expect } from 'vitest';
import { csvField, promptLine, resultsCsv, type CsvCloud } from '@/lib/resultsCsv';

const choice = (over: Partial<CsvCloud> = {}): CsvCloud => ({
  kind: 'choice', body: '# Best pet?\n\nPick one', options: ['Cat', 'Dog'], scaleMin: null, scaleMax: null, tally: { counts: [1, 2], totalVotes: 3 }, ...over,
});
const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n');

describe('results CSV', () => {
  it('starts with a byte-order mark, ends every line with CRLF, and has the columns in order', () => {
    const csv = resultsCsv('Town hall', [choice()]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines(csv)[0]).toBe('storm,cloud,kind,prompt,answer,count,percent');
  });

  it('writes one row per option, rating value and visible word, with percent of the cloud\'s votes to one decimal', () => {
    const csv = resultsCsv('S', [
      choice(),
      { kind: 'content', body: 'Skip me', options: null, scaleMin: null, scaleMax: null, tally: { counts: [], totalVotes: 0 } },
      { kind: 'rating', body: 'Rate', options: null, scaleMin: 1, scaleMax: 3, tally: { counts: { 1: 0, 2: 1, 3: 2 }, totalVotes: 3, average: 2.67 } },
      { kind: 'words', body: 'Words', options: null, scaleMin: null, scaleMax: null, tally: { words: [{ word: 'calm', count: 2 }, { word: 'rude', count: 1 }], totalVotes: 3 }, hiddenWords: ['rude'] },
      choice({ tally: { counts: [0, 0], totalVotes: 0 } }),
    ]);
    expect(lines(csv).slice(1, -1)).toEqual([
      'S,1,choice,Best pet?,Cat,1,33.3',
      'S,1,choice,Best pet?,Dog,2,66.7',
      'S,3,rating,Rate,1,0,0.0',
      'S,3,rating,Rate,2,1,33.3',
      'S,3,rating,Rate,3,2,66.7',
      'S,4,words,Words,calm,2,66.7',
      'S,5,choice,Best pet?,Cat,0,0.0',
      'S,5,choice,Best pet?,Dog,0,0.0',
    ]);
  });

  it('takes only the first line of the body as the prompt, without heading markers', () => {
    expect(promptLine('## What next?  \nmore')).toBe('What next?');
    expect(promptLine('  # Title')).toBe('Title');
    expect(promptLine('#hashtag poll')).toBe('#hashtag poll');
    expect(promptLine('Plain question\r\nsecond')).toBe('Plain question');
    expect(promptLine('\n\n  \n### After blank lines\nmore')).toBe('After blank lines');
    expect(promptLine('#')).toBe('');
    expect(promptLine('#\nSecond line')).toBe('');
  });

  it('gives a multi-select cloud each option\'s share of the voters, so the percents can add up to more than 100', () => {
    const csv = resultsCsv('S', [choice({ options: ['A', 'B', 'C'], tally: { counts: [2, 3, 0], totalVotes: 3 } })]);
    expect(lines(csv).slice(1, -1)).toEqual(['S,1,choice,Best pet?,A,2,66.7', 'S,1,choice,Best pet?,B,3,100.0', 'S,1,choice,Best pet?,C,0,0.0']);
  });

  it('writes zero rows for options and rating values, and no word rows, when a cloud has no tally', () => {
    const csv = resultsCsv('S', [
      choice({ tally: undefined }),
      { kind: 'rating', body: 'R', options: null, scaleMin: 1, scaleMax: 2, tally: null },
      { kind: 'words', body: 'W', options: null, scaleMin: null, scaleMax: null, tally: undefined },
    ]);
    expect(lines(csv).slice(1, -1)).toEqual(['S,1,choice,Best pet?,Cat,0,0.0', 'S,1,choice,Best pet?,Dog,0,0.0', 'S,2,rating,R,1,0,0.0', 'S,2,rating,R,2,0,0.0']);
  });

  it('quotes fields as RFC 4180 asks', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('plain')).toBe('plain');
    expect(csvField(-2)).toBe('-2');
  });

  it('stops a spreadsheet reading text as a formula', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x']) expect(csvField(evil)).toBe(`'${evil}`);
    expect(csvField('\r=x')).toBe(`"'\r=x"`);
    expect(csvField('=HYPERLINK("x","y"),z')).toBe(`"'=HYPERLINK(""x"",""y""),z"`);
    const csv = resultsCsv('=evil', [choice({ body: '@everyone vote', options: ['=cmd|calc', 'ok'] })]);
    expect(lines(csv)[1]).toBe(`'=evil,1,choice,'@everyone vote,'=cmd|calc,1,33.3`);
  });

  it('keeps emoji and accents as they are', () => {
    const csv = resultsCsv('Café 🌩️', [{ kind: 'words', body: 'Mood?', options: null, scaleMin: null, scaleMax: null, tally: { words: [{ word: '🎉 yay', count: 1 }], totalVotes: 1 } }]);
    expect(lines(csv)[1]).toBe('Café 🌩️,1,words,Mood?,🎉 yay,1,100.0');
  });

  it('writes rating values as numbers, so a negative scale is not mistaken for a formula', () => {
    const csv = resultsCsv('S', [{ kind: 'rating', body: 'R', options: null, scaleMin: -1, scaleMax: 0, tally: { counts: { '-1': 1, 0: 0 } as never, totalVotes: 1, average: -1 } }]);
    expect(lines(csv).slice(1, 3)).toEqual(['S,1,rating,R,-1,1,100.0', 'S,1,rating,R,0,0,0.0']);
  });
});
