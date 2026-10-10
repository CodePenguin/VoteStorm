// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WordCloud from '@/components/WordCloud.vue';

const words = [{ word: 'team', count: 5 }, { word: 'work', count: 1 }, { word: 'fun', count: 3 }];

describe('WordCloud', () => {
  it('lists every word with a bigger size for a bigger count', () => {
    const items = mount(WordCloud, { props: { words } }).findAll('li');
    expect(items).toHaveLength(3);
    const size = (w: string) => parseFloat(items.find((i) => i.text().startsWith(w))!.attributes('style')!.match(/font-size:\s*([\d.]+)em/)![1]);
    expect(size('team')).toBeGreaterThan(size('fun'));
    expect(size('fun')).toBeGreaterThan(size('work'));
  });
  it('reads to a screen reader as a list with how many people used each word', () => {
    const wrapper = mount(WordCloud, { props: { words } });
    expect(wrapper.find('ul').attributes('aria-label')).toBe('Word cloud, 3 words');
    expect(wrapper.text()).toContain('team, 5 people');
    expect(wrapper.text()).toContain('work, 1 person');
  });
  it('keeps the same order when the counts change', () => {
    const before = mount(WordCloud, { props: { words } }).findAll('li').map((i) => i.text().split(',')[0]);
    const after = mount(WordCloud, { props: { words: words.map((w) => ({ ...w, count: w.count + 7 })) } }).findAll('li').map((i) => i.text().split(',')[0]);
    expect(after).toEqual(before);
  });
  it('shows a gentle message when nobody has sent a word yet', () => {
    expect(mount(WordCloud, { props: { words: [] } }).text()).toContain('Waiting for words');
  });
});
