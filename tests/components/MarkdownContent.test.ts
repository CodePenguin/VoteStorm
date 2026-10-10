// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import MarkdownContent from '@/components/MarkdownContent.vue';

describe('MarkdownContent', () => {
  it('shows the text straight away and the formatting once the renderer has loaded', async () => {
    const wrapper = mount(MarkdownContent, { props: { source: '**Hi** there' } });
    expect(wrapper.text()).toContain('Hi');
    // The first render imports markdown-it for real, which takes longer than one flush.
    await vi.waitFor(() => expect(wrapper.find('strong').text()).toBe('Hi'));
  });
  // The slow-render drop is tested with a controlled renderer in MarkdownContentRace.test.ts.
  it('renders again when the source changes', async () => {
    const wrapper = mount(MarkdownContent, { props: { source: '# One' } });
    await flushPromises();
    await wrapper.setProps({ source: '# Two' });
    await flushPromises();
    expect(wrapper.find('h2').text()).toBe('Two');
  });
  it('marks itself large for the projector', () => {
    expect(mount(MarkdownContent, { props: { source: 'x', large: true } }).classes()).toContain('large');
  });
});
