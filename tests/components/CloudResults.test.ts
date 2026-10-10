// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CloudResults from '@/components/CloudResults.vue';
import type { Cloud } from '@/shared/types';

const base: Cloud = {
  id: 1, kind: 'choice', body: 'Pick', options: ['A', 'B', 'C'], scaleMin: null, scaleMax: null,
  multi: false, display: 'bars', resultsHidden: false, correct: null, maxWords: null,
};

describe('CloudResults', () => {
  it('renders a bar per option with counts, percentages and the leader marked', () => {
    const wrapper = mount(CloudResults, { props: { cloud: base, tally: { counts: [3, 1, 0], totalVotes: 4 } } });
    const bars = wrapper.findAll('.sbar');
    expect(bars).toHaveLength(3);
    expect(bars[0].text()).toContain('3');
    expect(bars[0].text()).toContain('75%');
    expect(bars[0].classes()).toContain('leader');
    expect(bars[1].classes()).not.toContain('leader');
    expect(wrapper.text()).toContain('4 responses');
  });

  it('marks revealed correct answers', () => {
    const wrapper = mount(CloudResults, { props: { cloud: { ...base, correct: [1] }, tally: { counts: [0, 2, 0], totalVotes: 2 } } });
    expect(wrapper.findAll('.sbar')[1].classes()).toContain('correct');
    expect(wrapper.findAll('.sbar')[0].classes()).not.toContain('correct');
  });

  it('renders one donut segment and legend row per option, with the total in the middle', () => {
    const wrapper = mount(CloudResults, {
      props: { cloud: { ...base, display: 'donut', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] }, tally: { counts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], totalVotes: 10 } },
    });
    expect(wrapper.findAll('.donut-seg')).toHaveLength(10);
    expect(wrapper.findAll('.donut-legend li')).toHaveLength(10);
    expect(wrapper.find('.donut-center strong').text()).toBe('10');
  });

  it('renders rating bars and an average', () => {
    const q: Cloud = { ...base, kind: 'rating', options: null, scaleMin: 1, scaleMax: 3 };
    const wrapper = mount(CloudResults, { props: { cloud: q, tally: { counts: { 1: 0, 2: 1, 3: 1 }, totalVotes: 2, average: 2.5 } } });
    expect(wrapper.findAll('.sbar')).toHaveLength(3);
    expect(wrapper.find('.slide-average strong').text()).toBe('2.5');
  });

  it('shows only a response counter while results are hidden', () => {
    const wrapper = mount(CloudResults, { props: { cloud: { ...base, resultsHidden: true }, tally: { totalVotes: 7, hidden: true } } });
    expect(wrapper.find('.big-count').text()).toBe('7');
    expect(wrapper.text()).toContain('responses received');
    expect(wrapper.find('.sbar').exists()).toBe(false);
  });

  it('marks rating scales so they render as compact single-line rows', () => {
    const q: Cloud = { ...base, kind: 'rating', options: null, scaleMin: 1, scaleMax: 10 };
    const wrapper = mount(CloudResults, { props: { cloud: q, tally: { counts: {}, totalVotes: 0, average: null } } });
    expect(wrapper.find('.results-view').classes()).toContain('rating');
    expect(wrapper.findAll('.sbar')).toHaveLength(10);
    expect(mount(CloudResults, { props: { cloud: base, tally: { counts: [0, 0, 0], totalVotes: 0 } } }).find('.results-view').classes()).not.toContain('rating');
  });

  it('does not repeat the total under a donut, which already shows it in the middle', () => {
    const wrapper = mount(CloudResults, { props: { cloud: { ...base, display: 'donut' }, tally: { counts: [2, 1, 0], totalVotes: 3 } } });
    expect(wrapper.find('.donut-center strong').text()).toBe('3');
    expect(wrapper.find('.slide-total').exists()).toBe(false);
  });

  it('can leave the total out when the page shows it elsewhere', () => {
    const wrapper = mount(CloudResults, { props: { cloud: base, tally: { counts: [2, 1, 0], totalVotes: 3 }, hideTotal: true } });
    expect(wrapper.find('.slide-total').exists()).toBe(false);
    expect(wrapper.findAll('.sbar')).toHaveLength(3);
  });

  it('renders a word cloud, and no bars, for a words cloud', () => {
    const wordsCloud: Cloud = { ...base, kind: 'words', options: null, maxWords: 3 };
    const wrapper = mount(CloudResults, { props: { cloud: wordsCloud, tally: { words: [{ word: 'team', count: 2 }], totalVotes: 2 } } });
    expect(wrapper.find('ul.word-cloud').text()).toContain('team');
    expect(wrapper.find('.sbar').exists()).toBe(false);
    expect(wrapper.text()).toContain('2 people have sent words');
  });

  it('renders no results block for a content cloud', () => {
    const content: Cloud = { ...base, kind: 'content', options: null };
    const wrapper = mount(CloudResults, { props: { cloud: content, tally: { counts: [], totalVotes: 0 } } });
    const view = wrapper.find('.results-view');
    expect(view.find('.sbar').exists()).toBe(false);
    expect(view.find('.donut').exists()).toBe(false);
    expect(view.find('.word-cloud').exists()).toBe(false);
    expect(view.find('.slide-total').exists()).toBe(false);
  });

  it('still shows the big response count for a words cloud with hidden results', () => {
    const wordsCloud: Cloud = { ...base, kind: 'words', options: null, maxWords: 3, resultsHidden: true };
    const wrapper = mount(CloudResults, { props: { cloud: wordsCloud, tally: { totalVotes: 4, hidden: true } } });
    expect(wrapper.find('.big-count').text()).toBe('4');
    expect(wrapper.find('.word-cloud').exists()).toBe(false);
  });
});
