// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppRouter, routes } from '@/router';
import ShareModal from '@/components/ShareModal.vue';
import CloudResults from '@/components/CloudResults.vue';
import type { Cloud } from '@/shared/types';

describe('share dialog focus', () => {
  const mountModal = () => mount(ShareModal, { props: { url: 'https://example.test/vote/ABC123' }, attachTo: document.body });
  const tab = (shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));

  it('moves focus into the dialog, keeps Tab inside it, and gives focus back when it closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const wrapper = mountModal();
    await flushPromises();
    const buttons = wrapper.findAll('button').map((b) => b.element as HTMLElement);
    expect(document.activeElement).toBe(buttons[0]);

    buttons[buttons.length - 1].focus();
    tab();
    expect(document.activeElement).toBe(buttons[0]);
    tab(true);
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    wrapper.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('asks to close on Escape', async () => {
    const wrapper = mountModal();
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('donut chart label', () => {
  it('describes the data, not just the chart type', () => {
    const cloud: Cloud = {
      id: 1, kind: 'choice', body: 'Pets?', options: ['Cat', 'Dog'], scaleMin: null, scaleMax: null, multi: false, display: 'donut', resultsHidden: false, correct: null,
    };
    const wrapper = mount(CloudResults, { props: { cloud, tally: { counts: [1, 3], totalVotes: 4 } } });
    expect(wrapper.find('[role="img"]').attributes('aria-label')).toBe('Donut chart of responses. Cat: 1 (25%), Dog: 3 (75%)');
  });
});

describe('page titles', () => {
  it('names each page in the tab, and falls back to the app name', async () => {
    const router = createAppRouter(createMemoryHistory());
    for (const [path, title] of [
      ['/privacy', 'Privacy · VoteStorm'],
      ['/license', 'License · VoteStorm'],
      ['/vote/ABC123', 'Vote · VoteStorm'],
      ['/results', 'Results · VoteStorm'],
      ['/presenter', 'Presenter · VoteStorm'],
      ['/nowhere', 'Page not found · VoteStorm'],
      ['/', 'VoteStorm'],
    ]) {
      await router.push(path);
      expect(document.title, path).toBe(title);
    }
  });

  it('is set for every route that is not the landing page', () => {
    const untitled = routes.filter((r) => r.name !== 'landing' && !('meta' in r && (r as { meta?: { title?: string } }).meta?.title));
    expect(untitled.map((r) => r.name)).toEqual([]);
    expect(createRouter({ history: createMemoryHistory(), routes })).toBeTruthy();
  });
});
