// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PresentStatus from '@/components/presenter/PresentStatus.vue';

describe('PresentStatus', () => {
  const lines = [{ key: 'state', text: 'Voting open', tone: 'on' as const }, { key: 'results', text: 'Results hidden', tone: 'warn' as const }, { key: 'join', text: 'Join screen off', tone: 'neutral' as const }];
  it('lists every line as a chip with its tone, in a labelled list', () => {
    const wrapper = mount(PresentStatus, { props: { lines } });
    expect(wrapper.find('ul').attributes('aria-label')).toBe('What the audience sees');
    const chips = wrapper.findAll('li');
    expect(chips.map((c) => c.text())).toEqual(['Voting open', 'Results hidden', 'Join screen off']);
    expect(chips[0].classes()).toContain('on');
    expect(chips[1].classes()).toContain('warn');
    expect(chips[2].classes()).toContain('neutral');
  });
  it('does not rely on colour alone: a warn line carries its meaning in its text', () => {
    expect(mount(PresentStatus, { props: { lines } }).findAll('li')[1].text()).toBe('Results hidden');
  });
});
