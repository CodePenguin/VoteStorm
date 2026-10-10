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

  // Layout fixes proved in a real browser (fix wave); these guard the rules that make them work.
  describe('participant page layout', () => {
    const line = (selector: string) => css.split(/\r?\n/).find((l) => l.trimStart().startsWith(selector + ' {')) ?? '';

    it('sticks the timer chip below the sticky header, not under it', () => {
      expect(line('.app-header .container')).toContain('height: 60px');
      expect(line('.sticky-timer')).toMatch(/top: (6[1-9]|7\d)px/);
    });

    it('lets table cells keep whole words so a wide table scrolls instead of squeezing', () => {
      expect(line('.md th, .md td')).toContain('overflow-wrap: normal');
    });

    it('makes the carousel track the containing block so off-screen slides cannot widen the page', () => {
      expect(css).toMatch(/\.carousel-track \{[^}]*position: relative/);
    });
  });

  describe('presenter and projector polish', () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, '../../src', f), 'utf8');
    const card = read('components/presenter/CloudCard.vue');
    // The Present stage replaced the old Present panel card: the same rules now live there.
    const stage = read('components/presenter/PresentStage.vue');

    it('keeps card headings at the card size and fades a cut-off card body or word preview', () => {
      expect(card).toMatch(/\.q-prompt \.md :is\(h2, h3, h4, h5, h6\) \{ font-size: inherit;/);
      expect(card).toMatch(/\.q-prompt\.clamp\.overflowing \{[^}]*mask-image: linear-gradient/);
      expect(stage).toMatch(/\.word-preview\.overflowing \{[^}]*mask-image: linear-gradient/);
    });

    it('bolds only a one-paragraph body or headings in the Present stage', () => {
      expect(stage).toMatch(/\.stage-title \{[^}]*font-weight: 400/);
      expect(stage).toMatch(/\.stage-title \.md > p:only-child \{ font-weight: 800; \}/);
    });

    it('limits the height of a picture on the projector summary', () => {
      expect(css).toMatch(/\.carousel\.large \.slide-title \.md img \{ max-height: 50vh;/);
    });
  });

  // jsdom has no layout, so the real-browser behaviour is proved by a Playwright run; these guard the CSS that makes it work.
  describe('projector fit-to-screen', () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, '../../src', f), 'utf8');
    const rule = (src: string, selector: string) => src.split(/\r?\n/).find((l) => l.trimStart().startsWith(selector + ' {') || l.trimStart().startsWith(selector + '{')) ?? '';
    const results = read('views/ResultsView.vue');
    const cloudResults = read('components/CloudResults.vue');

    it('scales every projector size inside the fit area by --fit, including the body text', () => {
      expect(rule(results, '.results-page .prompt')).toMatch(/font-size: calc\(var\(--fit, 1\) \*/);
      expect(rule(cloudResults, '.results-view.projector .sbar')).toMatch(/font-size: calc\(var\(--fit, 1\) \*/);
      expect(rule(cloudResults, '.results-view.projector .sbar-track')).toMatch(/height: calc\(var\(--fit, 1\) \*/);
      expect(rule(css, '.word-cloud.large')).toMatch(/font-size: calc\(var\(--fit, 1\) \*/);
    });

    it('floors the scale for a prompt that sits above results at 0.6', () => {
      expect(rule(results, '.results-page .prompt.keep-readable')).toMatch(/font-size: calc\(max\(var\(--fit, 1\), 0\.6\) \*/);
    });

    it('keeps question prompts at full weight and only lightens content bodies', () => {
      expect(results).toMatch(/\.results-page \.prompt:not\(\.keep-readable\) \.md :is\(p, li, td, th\) \{ font-weight: 600; \}/);
      expect(results).not.toMatch(/\.results-page \.prompt \.md :is\(p, li, td, th\)/);
      expect(rule(results, '.results-page .prompt')).toContain('font-weight: 800');
    });

    it('centres blocks in .results-main with auto margins, so a tall one is scrollable from its top', () => {
      expect(rule(results, '.results-main')).not.toContain('justify-content');
      expect(results).toMatch(/\.results-main > :is\(\.carousel, [^)]*\) \{ margin: auto 0; \}/);
    });

    it('gives the results page a definite height so the fit box is bounded and the page cannot scroll', () => {
      const page = rule(results, '.results-page');
      expect(page).toContain('height: 100dvh');
      expect(page).toContain('max-height: 100dvh');
      expect(rule(results, '.results-page .fit-box')).toMatch(/flex: 1 1 0; min-height: 0; overflow-y: auto/);
    });
  });
});
