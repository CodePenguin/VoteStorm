// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BrandMark from '@/components/BrandMark.vue';

describe('BrandMark', () => {
  it('names the product VoteStorm, exactly', () => {
    const wrapper = mount(BrandMark);
    expect(wrapper.text()).toBe('VoteStorm');
    expect(wrapper.find('.logo svg').exists()).toBe(true);
  });
});
