// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { Cloud } from '@/shared/types';

const apiMock = vi.fn();
vi.mock('@/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  getDeviceId: () => 'device-1',
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const channel = {
  handlers: {} as Record<string, (d: any) => void>,
  opts: {} as { onPresence?: (n: number) => void },
  close: vi.fn(),
};
vi.mock('@/composables/useStormChannel', () => ({
  subscribeStorm: (_code: string, handlers: Record<string, (d: any) => void>, opts: { onPresence?: (n: number) => void }) => {
    channel.handlers = handlers;
    channel.opts = opts;
    return { close: channel.close, connection: { state: 'connected', on: vi.fn() } };
  },
}));

import ResultsView from '@/views/ResultsView.vue';

const q: Cloud = {
  id: 5, kind: 'choice', body: 'Best pet?', options: ['Cat', 'Dog'], scaleMin: null, scaleMax: null,
  multi: false, display: 'bars', resultsHidden: false, correct: null,
};

type Routes = Record<string, unknown | (() => unknown)>;

async function mountResults(url: string, responses: Routes) {
  apiMock.mockImplementation(async (path: string, options?: RequestInit) => {
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    if (!key) throw new Error('unexpected ' + path);
    const r = responses[key];
    const value = typeof r === 'function' ? (r as (p: string, o?: RequestInit) => unknown)(path, options) : r;
    if (value instanceof Error) throw value;
    return value;
  });
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push(url);
  await router.isReady();
  const wrapper = mount(ResultsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const resolved = { 'resolve-results-key': { stormCode: 'ABCDEFGH' } };

describe('ResultsView', () => {
  beforeEach(() => {
    apiMock.mockReset();
    channel.close.mockReset();
  });

  it('uses the presenter\'s background colour from the start, and follows live changes and resets', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      'resolve-results-key': { stormCode: 'ABCDEFGH', resultsBackground: '#1e293b' },
      'get-storm-state': { status: 'active', currentCloud: q, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
    });
    const page = () => wrapper.find('.results-page').attributes('style') ?? '';
    expect(page()).toContain('--bg: #1e293b');
    expect(page()).toContain('--text: #f8fafc'); // dark background, light text

    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false, resultsBackground: '#ffffff' });
    await flushPromises();
    expect(page()).toContain('--bg: #ffffff');
    expect(page()).toContain('--text: #0f172a');

    // A state event that does not mention the colour leaves it alone; null returns to the default theme.
    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false });
    await flushPromises();
    expect(page()).toContain('--bg: #ffffff');
    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false, resultsBackground: null });
    await flushPromises();
    expect(page()).not.toContain('--bg');
  });

  it('shows a countdown, then "Voting closed", beside the Live badge', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentCloud: { ...q, votingMsLeft: 90000 }, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
    });
    expect(wrapper.find('.voting-badge').text()).toBe('1:30');

    channel.handlers.state({ status: 'active', currentCloud: { ...q, votingMsLeft: 0 }, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false });
    await flushPromises();
    expect(wrapper.find('.voting-badge').text()).toBe('Voting closed');

    channel.handlers.state({ status: 'active', currentCloud: { ...q, votingMsLeft: null }, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false });
    await flushPromises();
    expect(wrapper.find('.voting-badge').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the live cloud with projector bars and the response count', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentCloud: q, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
    });
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(wrapper.find('.results-view.projector').exists()).toBe(true);
    expect(wrapper.findAll('.sbar')).toHaveLength(2);
    expect(wrapper.find('.footer').text()).toContain('4 responses');
    expect(wrapper.find('.footer').text()).toContain('Storm code ABCD EFGH');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('shows "Results not found" for an unknown key', async () => {
    const { ApiError } = await import('@/api');
    const wrapper = await mountResults('/results#k=BAD', { 'resolve-results-key': new ApiError('Results not found', 404) });
    expect(wrapper.find('.alert').text()).toBe('Results not found.');
  });

  it('shows the join screen when the server says so, with the live connected count', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'lobby', currentCloud: null, tally: null, showConnect: true },
    });
    const screen = wrapper.find('.connect-screen');
    expect((screen.element as HTMLElement).style.display).not.toBe('none');
    expect(screen.text()).toContain('Scan to vote');
    expect(screen.text()).toContain('localhost:3000/vote/ABCDEFGH'.replace('localhost:3000', window.location.host));
    expect(screen.text()).toContain('0 people connected');
    channel.opts.onPresence!(1);
    await flushPromises();
    expect(screen.text()).toContain('1 person connected');
    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: { counts: [0, 0], totalVotes: 0 }, showConnect: false });
    await flushPromises();
    expect((screen.element as HTMLElement).style.display).toBe('none');
  });

  it('updates bars live from tally events', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentCloud: q, tally: { counts: [0, 0], totalVotes: 0 }, showConnect: false },
    });
    channel.handlers.tally({ cloudId: 5, counts: [0, 6], totalVotes: 6 });
    await flushPromises();
    expect(wrapper.findAll('.sbar')[1].classes()).toContain('leader');
    channel.handlers.tally({ cloudId: 99, counts: [9, 9], totalVotes: 18 });
    await flushPromises();
    expect(wrapper.find('.footer').text()).toContain('6 responses');
  });

  it('shows only a big response counter while results are hidden', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentCloud: { ...q, resultsHidden: true }, tally: { totalVotes: 3, hidden: true }, showConnect: false },
    });
    expect(wrapper.find('.big-count').text()).toBe('3');
    expect(wrapper.find('.sbar').exists()).toBe(false);
    expect(wrapper.find('.footer-info').text()).not.toContain('response');
  });

  it('shows the swipeable results with no buttons once the storm is closed', async () => {
    const wrapper = await mountResults('/results#k=KEY', {
      ...resolved,
      'get-storm-state': { status: 'closed', currentCloud: null, tally: null, showConnect: false },
      'get-storm-results': { clouds: [{ ...q, tally: { counts: [1, 2], totalVotes: 3 } }] },
    });
    expect(wrapper.find('.carousel.large').exists()).toBe(true);
    expect(wrapper.text()).toContain('Cloud 1');
    expect(wrapper.text()).toContain('Swipe or use the arrow keys');
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('.topbar .badge').exists()).toBe(false);
  });

  it('a pinned link activates its cloud using the results key, then shows it', async () => {
    const wrapper = await mountResults('/results#k=KEY&c=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-cloud-results': { status: 'active', live: true, cloud: q, tally: { counts: [1, 0], totalVotes: 1 } },
    });
    const activate = apiMock.mock.calls.find((c) => c[0] === 'results-activate')!;
    expect(JSON.parse(activate[1].body)).toEqual({ resultsKey: 'KEY', cloudId: 5 });
    expect(apiMock.mock.calls.find((c) => String(c[0]).startsWith('get-cloud-results'))![0]).toContain('cloudId=5');
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(apiMock.mock.calls.some((c) => String(c[0]).startsWith('get-storm-state'))).toBe(false);
  });

  it('a pinned link shows only a message when its cloud is not live, and follows it when it goes live', async () => {
    let live = false;
    const wrapper = await mountResults('/results#k=KEY&c=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-cloud-results': () => (live
        ? { status: 'active', live: true, cloud: q, tally: { counts: [0, 0], totalVotes: 0 } }
        : { status: 'active', live: false, cloud: null, tally: null }),
    });
    expect(wrapper.find('.not-active').text()).toContain("isn’t active right now");
    expect(wrapper.find('.prompt').exists()).toBe(false);
    live = true;
    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: null, showConnect: false });
    await flushPromises();
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(wrapper.find('.not-active').exists()).toBe(false);
  });

  it('a pinned link ignores the join screen toggle', async () => {
    const wrapper = await mountResults('/results#k=KEY&c=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-cloud-results': { status: 'active', live: true, cloud: q, tally: { counts: [0, 0], totalVotes: 0 } },
    });
    channel.handlers.state({ status: 'active', currentCloud: q, initialTally: null, showConnect: true });
    await flushPromises();
    expect((wrapper.find('.connect-screen').element as HTMLElement).style.display).toBe('none');
  });

  it('shows that it is loading until the storm has loaded, and stops if the key is unknown', async () => {
    let release: (v: unknown) => void = () => {};
    apiMock.mockImplementation((path: string) => (path.startsWith('resolve-results-key') ? new Promise((r) => (release = r)) : Promise.resolve({})));
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/results#k=KEY');
    await router.isReady();
    const wrapper = mount(ResultsView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('.results-loading').text()).toContain('Loading');
    const { ApiError } = await import('@/api');
    release(Promise.reject(new ApiError('Results not found', 404)));
    await flushPromises();
    expect(wrapper.find('.results-loading').exists()).toBe(false);
    expect(wrapper.find('.alert').text()).toBe('Results not found.');
  });

  describe('content and word clouds', () => {
    const content: Cloud = { ...q, id: 7, kind: 'content', body: '# Title\n\nSome **text**', options: null };
    const words: Cloud = { ...q, id: 8, kind: 'words', body: 'One word?', options: null, maxWords: 3 };

    it('shows a live content cloud large in the fit box, with no count and no results', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: content, tally: null, showConnect: false },
      });
      await vi.waitFor(() => expect(wrapper.find('.fit-box .md.large strong').text()).toBe('text'));
      expect(wrapper.find('.footer-info').text()).not.toContain('response');
      expect(wrapper.find('.sbar').exists()).toBe(false);
      expect(wrapper.find('.big-count').exists()).toBe(false);
    });

    it('shows a choice cloud body as markdown with the bars and the response count', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: { ...q, body: 'Best **pet**?' }, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
      });
      await vi.waitFor(() => expect(wrapper.find('.fit-box .md strong').text()).toBe('pet'));
      expect(wrapper.findAll('.sbar')).toHaveLength(2);
      expect(wrapper.find('.footer').text()).toContain('4 responses');
    });

    it('shows a words cloud, the people count in the footer, and adds a new word from a tally event', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: words, tally: { words: [{ word: 'team', count: 2 }], totalVotes: 2 }, showConnect: false },
      });
      expect(wrapper.find('ul.word-cloud').text()).toContain('team');
      expect(wrapper.find('.footer-info').text()).toContain('2 people have sent words');
      channel.handlers.tally({ cloudId: 8, words: [{ word: 'team', count: 2 }, { word: 'focus', count: 1 }], totalVotes: 3 });
      await flushPromises();
      expect(wrapper.find('ul.word-cloud').text()).toContain('focus');
      channel.handlers.tally({ cloudId: 8, words: [{ word: 'team', count: 1 }], totalVotes: 1 });
      await flushPromises();
      expect(wrapper.find('.footer-info').text()).toContain('1 person has sent words');
    });

    it('words the closed timer badge by kind, and shows a running clock for any kind', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: { ...content, votingMsLeft: 90000 }, tally: null, showConnect: false },
      });
      expect(wrapper.find('.voting-badge').text()).toBe('1:30');
      const push = async (cloud: Cloud) => {
        channel.handlers.state({ status: 'active', currentCloud: { ...cloud, votingMsLeft: 0 }, initialTally: null, showConnect: false });
        await flushPromises();
        return wrapper.find('.voting-badge').text();
      };
      expect(await push(content)).toBe("Time's up");
      expect(await push(words)).toBe('Submissions closed');
      expect(await push(q)).toBe('Voting closed');
    });

    it('has one sr-only h1 for the page and no h1 inside the rendered body', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: content, tally: null, showConnect: false },
      });
      await vi.waitFor(() => expect(wrapper.find('.fit-box .md h2').exists()).toBe(true));
      const heading = wrapper.find('main h1');
      expect(wrapper.findAll('main h1')).toHaveLength(1);
      expect(heading.classes()).toContain('sr-only');
      expect(heading.text()).toBe('Current cloud');
      expect(wrapper.find('.md h1').exists()).toBe(false);
    });

    it('keeps a question or words prompt at a readable floor, but lets a content body shrink fully', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: content, tally: null, showConnect: false },
      });
      expect(wrapper.find('.prompt').classes()).not.toContain('keep-readable');
      for (const cloud of [words, q]) {
        channel.handlers.state({ status: 'active', currentCloud: cloud, initialTally: null, showConnect: false });
        await flushPromises();
        expect(wrapper.find('.prompt').classes()).toContain('keep-readable');
      }
    });

    it('fits tall content to the box', async () => {
      const wrapper = await mountResults('/results#k=KEY', {
        ...resolved,
        'get-storm-state': { status: 'active', currentCloud: content, tally: null, showConnect: false },
      });
      const box = wrapper.find('.fit-box').element as HTMLElement;
      const inner = wrapper.find('.fit-inner').element as HTMLElement;
      expect(inner.style.getPropertyValue('--fit')).not.toBe('');
      Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 600 });
      Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => 1000 * parseFloat(inner.style.getPropertyValue('--fit') || '1') });
      channel.handlers.state({ status: 'active', currentCloud: { ...content, id: 9 }, initialTally: null, showConnect: false });
      await flushPromises();
      expect(parseFloat(inner.style.getPropertyValue('--fit'))).toBeLessThan(1);
    });
  });
});
