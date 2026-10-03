// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AppFooter from '@/components/AppFooter.vue';

describe('AppFooter', () => {
  it('credits Code Penguin with a link to codepenguin.com', () => {
    const wrapper = mount(AppFooter);
    const link = wrapper.find('a');
    expect(link.attributes('href')).toBe('https://codepenguin.com');
    expect(link.text().replace(/\u00a0/g, ' ')).toBe('David Lambert (Code Penguin)');
    expect(wrapper.text()).toContain('Copyright');
  });
});
