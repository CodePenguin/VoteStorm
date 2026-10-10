// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// renderMarkdown is replaced by deferred promises so the test decides which render finishes first.
const pending: { source: string; resolve: (html: string) => void; reject: (e: Error) => void }[] = [];
vi.mock('@/lib/markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/markdown')>();
  return {
    ...real,
    renderMarkdown: (source: string) => new Promise<string>((resolve, reject) => pending.push({ source, resolve, reject })),
  };
});

import MarkdownContent from '@/components/MarkdownContent.vue';

describe('MarkdownContent with a slow renderer', () => {
  beforeEach(() => {
    pending.length = 0;
  });

  it('drops a render for an older source that finishes after the newer one', async () => {
    const wrapper = mount(MarkdownContent, { props: { source: 'old' } });
    await wrapper.setProps({ source: 'new' });
    expect(pending.map((p) => p.source)).toEqual(['old', 'new']);
    pending[1].resolve('<p>NEW</p>');
    await flushPromises();
    pending[0].resolve('<p>OLD</p>');
    await flushPromises();
    expect(wrapper.html()).toContain('NEW');
    expect(wrapper.html()).not.toContain('OLD');
  });

  it('keeps the plain text when the renderer cannot load', async () => {
    const wrapper = mount(MarkdownContent, { props: { source: '**Hi** <b>there</b>' } });
    pending[0].reject(new Error('Failed to fetch dynamically imported module'));
    await flushPromises();
    expect(wrapper.text()).toBe('**Hi** <b>there</b>');
    expect(wrapper.find('b').exists()).toBe(false);
  });
});
