// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ResultsCarousel from '@/components/ResultsCarousel.vue';
import type { ClosedCloud } from '@/shared/types';

const base = { options: null, scaleMin: null, scaleMax: null, multi: false, display: 'bars', resultsHidden: false, correct: null } as const;
const slides = [
  { ...base, id: 1, kind: 'choice', body: 'Best pet?', options: ['Cat', 'Dog'], tally: { counts: [1, 2], totalVotes: 3 } },
  { ...base, id: 2, kind: 'content', body: '# Welcome\n\nHello **all**', tally: { totalVotes: 0 } },
  { ...base, id: 3, kind: 'words', body: 'One word?', tally: { words: [{ word: 'team', count: 2 }], totalVotes: 2 } },
] as ClosedCloud[];

describe('ResultsCarousel', () => {
  it('renders every cloud in order with its eyebrow, and each kind as it should be', async () => {
    const wrapper = mount(ResultsCarousel, { props: { slides } });
    const cards = wrapper.findAll('.slide-card');
    expect(cards.map((c) => c.find('.slide-eyebrow').text())).toEqual(['Cloud 1', 'Cloud 2', 'Cloud 3']);
    expect(cards[0].findAll('.sbar')).toHaveLength(2);
    await vi.waitFor(() => expect(cards[1].find('.slide-title strong').text()).toBe('all'));
    expect(cards[1].find('.sbar').exists()).toBe(false);
    expect(cards[1].find('.word-cloud').exists()).toBe(false);
    expect(cards[2].find('ul.word-cloud').text()).toContain('team');
  });

  it('uses a div for the slide body so headings do not nest', async () => {
    const wrapper = mount(ResultsCarousel, { props: { slides } });
    const title = wrapper.findAll('.slide-title')[1];
    expect(title.element.tagName).toBe('DIV');
    await vi.waitFor(() => expect(title.find('h2').exists()).toBe(true));
    expect(wrapper.find('h1').exists()).toBe(false);
  });

  it('labels the navigation buttons', () => {
    const wrapper = mount(ResultsCarousel, { props: { slides } });
    expect(wrapper.find('[aria-label="Previous cloud"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Next cloud"]').exists()).toBe(true);
  });

  it('says so when there are no clouds', () => {
    expect(mount(ResultsCarousel, { props: { slides: [] } }).text()).toContain('No clouds to show');
  });
});
