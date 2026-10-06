// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { Question } from '@/shared/types';

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

const q: Question = {
  id: 5, type: 'choice', prompt: 'Best pet?', options: ['Cat', 'Dog'], scaleMin: null, scaleMax: null,
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

const resolved = { 'resolve-results-key': { stormCode: 'STORM01' } };

describe('ResultsView', () => {
  beforeEach(() => {
    apiMock.mockReset();
    channel.close.mockReset();
  });

  it('uses the presenter\'s background colour from the start, and follows live changes and resets', async () => {
    const wrapper = await mountResults('/results/KEY', {
      'resolve-results-key': { stormCode: 'STORM01', resultsBackground: '#1e293b' },
      'get-storm-state': { status: 'active', currentQuestion: q, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
    });
    const page = () => wrapper.find('.results-page').attributes('style') ?? '';
    expect(page()).toContain('--bg: #1e293b');
    expect(page()).toContain('--text: #f8fafc'); // dark background, light text

    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false, resultsBackground: '#ffffff' });
    await flushPromises();
    expect(page()).toContain('--bg: #ffffff');
    expect(page()).toContain('--text: #0f172a');

    // A state event that does not mention the colour leaves it alone; null returns to the default theme.
    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false });
    await flushPromises();
    expect(page()).toContain('--bg: #ffffff');
    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: { counts: [3, 1], totalVotes: 4 }, showConnect: false, resultsBackground: null });
    await flushPromises();
    expect(page()).not.toContain('--bg');
  });

  it('shows the live question with projector bars and the response count', async () => {
    const wrapper = await mountResults('/results/KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentQuestion: q, tally: { counts: [3, 1], totalVotes: 4 }, showConnect: false },
    });
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(wrapper.find('.results-view.projector').exists()).toBe(true);
    expect(wrapper.findAll('.sbar')).toHaveLength(2);
    expect(wrapper.find('.footer').text()).toContain('4 responses');
    expect(wrapper.find('.footer').text()).toContain('Storm code STORM01');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('shows "Results not found" for an unknown key', async () => {
    const { ApiError } = await import('@/api');
    const wrapper = await mountResults('/results/BAD', { 'resolve-results-key': new ApiError('Results not found', 404) });
    expect(wrapper.find('.alert').text()).toBe('Results not found.');
  });

  it('shows the join screen when the server says so, with the live connected count', async () => {
    const wrapper = await mountResults('/results/KEY', {
      ...resolved,
      'get-storm-state': { status: 'lobby', currentQuestion: null, tally: null, showConnect: true },
    });
    const screen = wrapper.find('.connect-screen');
    expect((screen.element as HTMLElement).style.display).not.toBe('none');
    expect(screen.text()).toContain('Scan to vote');
    expect(screen.text()).toContain('localhost:3000/vote/STORM01'.replace('localhost:3000', window.location.host));
    expect(screen.text()).toContain('0 people connected');
    channel.opts.onPresence!(1);
    await flushPromises();
    expect(screen.text()).toContain('1 person connected');
    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: { counts: [0, 0], totalVotes: 0 }, showConnect: false });
    await flushPromises();
    expect((screen.element as HTMLElement).style.display).toBe('none');
  });

  it('updates bars live from tally events', async () => {
    const wrapper = await mountResults('/results/KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentQuestion: q, tally: { counts: [0, 0], totalVotes: 0 }, showConnect: false },
    });
    channel.handlers.tally({ questionId: 5, counts: [0, 6], totalVotes: 6 });
    await flushPromises();
    expect(wrapper.findAll('.sbar')[1].classes()).toContain('leader');
    channel.handlers.tally({ questionId: 99, counts: [9, 9], totalVotes: 18 });
    await flushPromises();
    expect(wrapper.find('.footer').text()).toContain('6 responses');
  });

  it('shows only a big response counter while results are hidden', async () => {
    const wrapper = await mountResults('/results/KEY', {
      ...resolved,
      'get-storm-state': { status: 'active', currentQuestion: { ...q, resultsHidden: true }, tally: { totalVotes: 3, hidden: true }, showConnect: false },
    });
    expect(wrapper.find('.big-count').text()).toBe('3');
    expect(wrapper.find('.sbar').exists()).toBe(false);
    expect(wrapper.find('.footer-info').text()).not.toContain('response');
  });

  it('shows the swipeable results with no buttons once the storm is closed', async () => {
    const wrapper = await mountResults('/results/KEY', {
      ...resolved,
      'get-storm-state': { status: 'closed', currentQuestion: null, tally: null, showConnect: false },
      'get-storm-results': { questions: [{ ...q, tally: { counts: [1, 2], totalVotes: 3 } }] },
    });
    expect(wrapper.find('.carousel.large').exists()).toBe(true);
    expect(wrapper.text()).toContain('Question 1');
    expect(wrapper.text()).toContain('Swipe or use the arrow keys');
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('.topbar .badge').exists()).toBe(false);
  });

  it('a pinned link activates its question using the results key, then shows it', async () => {
    const wrapper = await mountResults('/results/KEY?q=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-question-results': { status: 'active', live: true, question: q, tally: { counts: [1, 0], totalVotes: 1 } },
    });
    const activate = apiMock.mock.calls.find((c) => c[0] === 'results-activate')!;
    expect(JSON.parse(activate[1].body)).toEqual({ resultsKey: 'KEY', questionId: 5 });
    expect(apiMock.mock.calls.find((c) => String(c[0]).startsWith('get-question-results'))![0]).toContain('questionId=5');
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(apiMock.mock.calls.some((c) => String(c[0]).startsWith('get-storm-state'))).toBe(false);
  });

  it('a pinned link shows only a message when its question is not live, and follows it when it goes live', async () => {
    let live = false;
    const wrapper = await mountResults('/results/KEY?q=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-question-results': () => (live
        ? { status: 'active', live: true, question: q, tally: { counts: [0, 0], totalVotes: 0 } }
        : { status: 'active', live: false, question: null, tally: null }),
    });
    expect(wrapper.find('.not-active').text()).toContain("isn’t active right now");
    expect(wrapper.find('.prompt').exists()).toBe(false);
    live = true;
    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: null, showConnect: false });
    await flushPromises();
    expect(wrapper.find('.prompt').text()).toBe('Best pet?');
    expect(wrapper.find('.not-active').exists()).toBe(false);
  });

  it('a pinned link ignores the join screen toggle', async () => {
    const wrapper = await mountResults('/results/KEY?q=5', {
      ...resolved,
      'results-activate': { ok: true },
      'get-question-results': { status: 'active', live: true, question: q, tally: { counts: [0, 0], totalVotes: 0 } },
    });
    channel.handlers.state({ status: 'active', currentQuestion: q, initialTally: null, showConnect: true });
    await flushPromises();
    expect((wrapper.find('.connect-screen').element as HTMLElement).style.display).toBe('none');
  });

  it('shows that it is loading until the storm has loaded, and stops if the key is unknown', async () => {
    let release: (v: unknown) => void = () => {};
    apiMock.mockImplementation((path: string) => (path.startsWith('resolve-results-key') ? new Promise((r) => (release = r)) : Promise.resolve({})));
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/results/KEY');
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
});
