// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import QuestionResults from '@/components/QuestionResults.vue';
import type { Question } from '@/shared/types';

const base: Question = {
  id: 1, type: 'choice', prompt: 'Pick', options: ['A', 'B', 'C'], scaleMin: null, scaleMax: null,
  multi: false, display: 'bars', resultsHidden: false, correct: null,
};

describe('QuestionResults', () => {
  it('renders a bar per option with counts, percentages and the leader marked', () => {
    const wrapper = mount(QuestionResults, { props: { question: base, tally: { counts: [3, 1, 0], totalVotes: 4 } } });
    const bars = wrapper.findAll('.sbar');
    expect(bars).toHaveLength(3);
    expect(bars[0].text()).toContain('3');
    expect(bars[0].text()).toContain('75%');
    expect(bars[0].classes()).toContain('leader');
    expect(bars[1].classes()).not.toContain('leader');
    expect(wrapper.text()).toContain('4 responses');
  });

  it('marks revealed correct answers', () => {
    const wrapper = mount(QuestionResults, { props: { question: { ...base, correct: [1] }, tally: { counts: [0, 2, 0], totalVotes: 2 } } });
    expect(wrapper.findAll('.sbar')[1].classes()).toContain('correct');
    expect(wrapper.findAll('.sbar')[0].classes()).not.toContain('correct');
  });

  it('renders one donut segment and legend row per option, with the total in the middle', () => {
    const wrapper = mount(QuestionResults, {
      props: { question: { ...base, display: 'donut', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] }, tally: { counts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], totalVotes: 10 } },
    });
    expect(wrapper.findAll('.donut-seg')).toHaveLength(10);
    expect(wrapper.findAll('.donut-legend li')).toHaveLength(10);
    expect(wrapper.find('.donut-center strong').text()).toBe('10');
  });

  it('renders rating bars and an average', () => {
    const q: Question = { ...base, type: 'rating', options: null, scaleMin: 1, scaleMax: 3 };
    const wrapper = mount(QuestionResults, { props: { question: q, tally: { counts: { 1: 0, 2: 1, 3: 1 }, totalVotes: 2, average: 2.5 } } });
    expect(wrapper.findAll('.sbar')).toHaveLength(3);
    expect(wrapper.find('.slide-average strong').text()).toBe('2.5');
  });

  it('shows only a response counter while results are hidden', () => {
    const wrapper = mount(QuestionResults, { props: { question: { ...base, resultsHidden: true }, tally: { totalVotes: 7, hidden: true } } });
    expect(wrapper.find('.big-count').text()).toBe('7');
    expect(wrapper.text()).toContain('responses received');
    expect(wrapper.find('.sbar').exists()).toBe(false);
  });
});
