import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.resolve(__dirname, '../../src/assets/styles.css'), 'utf8');

describe('stylesheet', () => {
  it('marks a correct bar with a real tick, written as a CSS escape (not mangled text)', () => {
    const rule = css.split('\n').find((line) => line.includes('.sbar.correct .sbar-head .label::after'));
    expect(rule).toContain("content: ' \\2713'");
  });

  it('contains only plain ASCII, so no escape sequence can have been turned into stray characters', () => {
    const stray = css.split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => /[^\x00-\x7F]/.test(line));
    expect(stray).toEqual([]);
  });
});
