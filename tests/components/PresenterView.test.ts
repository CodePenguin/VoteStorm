// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { AdminQuestion, AdminStormData } from '@/shared/types';
import { loadRecent, rememberStorm } from '@/lib/recentStorms';

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const calls: { path: string; body: any; method?: string; key?: string }[] = [];
let data: AdminStormData;
let failNext: Error | null = null;

const apiMock = vi.fn(async (path: string, options: RequestInit = {}) => {
  const body = options.body ? JSON.parse(options.body as string) : undefined;
  calls.push({ path, body, method: options.method, key: (options.headers as Record<string, string> | undefined)?.['x-admin-key'] });
  if (failNext && options.method === 'PATCH') {
    const err = failNext;
    failNext = null;
    throw err;
  }
  if (path === 'admin-storm' && !options.method) return JSON.parse(JSON.stringify(data));
  if (path === 'admin-storm' && options.method === 'PATCH' && body.currentQuestionId) {
    data.storm.current_question_id = body.currentQuestionId;
    data.storm.status = 'active';
  }
  if (path === 'admin-storm' && options.method === 'PATCH' && body.questionId && body.resultsHidden !== undefined) {
    data.questions.find((q) => q.id === body.questionId)!.results_hidden = body.resultsHidden ? 1 : 0;
  }
  if (path === 'create-storm') return { adminKey: 'NEWKEY', stormCode: 'NEW001' };
  if (path === 'duplicate-storm') return { adminKey: 'COPYKEY', stormCode: 'COPY01' };
  return { ok: true };
});
vi.mock('@/api', () => ({ api: (...a: [string, RequestInit?]) => apiMock(...a), getDeviceId: () => 'd', ApiError: FakeApiError }));

const channel = { handlers: {} as Record<string, (d: any) => void>, close: vi.fn() };
vi.mock('@/composables/useStormChannel', () => ({
  subscribeStorm: (_c: string, handlers: Record<string, (d: any) => void>) => {
    channel.handlers = handlers;
    return { close: channel.close };
  },
}));

const copied: string[] = [];
vi.mock('@/composables/useClipboard', () => ({ copyText: async (t: string) => (copied.push(t), true) }));

import PresenterView from '@/views/PresenterView.vue';

const question = (id: number, over: Partial<AdminQuestion> = {}): AdminQuestion => ({
  id, storm_code: 'STORM01', order_index: id, type: 'choice', prompt: `Question ${id}`, options: JSON.stringify(['A', 'B']),
  scale_min: null, scale_max: null, multi: 0, results_hidden: 0, answer_shown: 0, correct: null, display: 'bars',
  tally: { counts: [2, 1], totalVotes: 3 }, ...over,
});

async function mountPresenter(url = '/presenter#key=ADMINKEY') {
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push(url);
  await router.isReady();
  const wrapper = mount(PresenterView, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, router };
}

const btn = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find((b) => b.text() === text)!;
const patchCalls = (path: string) => calls.filter((c) => c.path === path && c.method === 'PATCH').map((c) => c.body);

describe('PresenterView', () => {
  beforeEach(() => {
    calls.length = 0;
    copied.length = 0;
    failNext = null;
    apiMock.mockClear();
    localStorage.clear();
    window.confirm = vi.fn(() => true);
    window.scrollTo = vi.fn();
    data = {
      storm: { storm_code: 'STORM01', status: 'active', current_question_id: 1 },
      questions: [question(1, { correct: JSON.stringify([0]) }), question(2, { type: 'choice', display: 'donut', results_hidden: 1 })],
      showConnect: false,
      resultsKey: 'RESKEY',
      license: { tier: 'licensed', name: 'Acme', expiresAt: null, limits: { stormInactivityHours: 48, maxQuestionsPerStorm: 25 } },
    };
  });

  it('starts in Edit mode showing question setup, not results', async () => {
    const { wrapper } = await mountPresenter();
    expect(wrapper.find('.seg button.on').text()).toBe('Edit');
    const cards = wrapper.findAll('.question');
    expect(cards).toHaveLength(2);
    expect(cards[0].classes()).toContain('active');
    expect(cards[0].text()).toContain('Question 1');
    expect(cards[0].findAll('.chip').map((c) => c.text())).toEqual(['A ✓', 'B']);
    expect(cards[1].text()).toContain('Donut');
    expect(cards[1].text()).toContain('Results hidden');
    expect(wrapper.find('.question .sbar').exists()).toBe(false);
    expect(wrapper.find('.tabs').text()).toContain('Questions (2)');
  });

  it('Present mode shows the live results and controls, remembers the mode, and Next advances the question', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(localStorage.getItem('votestorm_mode')).toBe('present');
    const now = wrapper.find('.present-now');
    expect(now.text()).toContain('Question 1');
    expect(now.findAll('.sbar')).toHaveLength(2);
    expect(wrapper.find('.present-nav .btn.primary').text()).toContain('Next');
    await wrapper.find('.present-nav .btn.primary').trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ status: 'active', currentQuestionId: 2 });
    expect(wrapper.find('.present-now').text()).toContain('Question 2');
    expect(wrapper.findAll('.present-row')[1].classes()).toContain('live');
  });

  it('opens in Present mode when that was the last mode used', async () => {
    localStorage.setItem('votestorm_mode', 'present');
    const { wrapper } = await mountPresenter();
    expect(wrapper.find('.seg button.on').text()).toBe('Present');
  });

  it('shows the hidden results to the presenter with a note, and toggles them per question', async () => {
    data.storm.current_question_id = 2;
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(wrapper.find('.present-now').text()).toContain('hidden from the audience');
    expect(wrapper.find('.present-now .donut').exists()).toBe(true);
    const toggle = wrapper.findAll('.present-now .toolbar .btn').find((b) => b.text() === 'Show results')!;
    await toggle.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ questionId: 2, resultsHidden: false });
  });

  it('keeps the live controls above the results so they stay on screen with a long scale', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    const html = wrapper.find('.present-now').html();
    expect(html.indexOf('Hide results')).toBeGreaterThan(-1);
    expect(html.indexOf('Hide results')).toBeLessThan(html.indexOf('sbar'));
    expect(wrapper.find('.present-now .slide-total').exists()).toBe(false);
  });

  it('reveals the correct answer for the live question', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    await wrapper.findAll('.present-now .toolbar .btn').find((b) => b.text() === 'Reveal answer')!.trigger('click');
    expect(patchCalls('admin-storm')).toContainEqual({ questionId: 1, answerShown: true });
  });

  it('activates a question from its Edit card', async () => {
    const { wrapper } = await mountPresenter();
    const card = wrapper.findAll('.question')[1];
    await card.findAll('.btn').find((b) => b.text() === 'Activate')!.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ status: 'active', currentQuestionId: 2 });
  });

  it('copies a results link built from the results key, not the storm code', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.question')[1].findAll('.btn').find((b) => b.text() === 'Copy results link')!.trigger('click');
    await flushPromises();
    expect(copied).toEqual([`${window.location.origin}/results#key=RESKEY&q=2`]);
  });

  it('adds a question, mapping the typed correct answer to its index', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.section-head .btn')[0].trigger('click');
    const inputs = wrapper.findAll('.card input.input');
    await inputs[0].setValue('Best pet?');
    await inputs[1].setValue('Cat, Dog');
    await inputs[2].setValue('dog');
    await btn(wrapper, 'Save question').trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.path === 'admin-questions' && c.method === 'POST')!;
    expect(post.body).toMatchObject({ type: 'choice', prompt: 'Best pet?', options: ['Cat', 'Dog'], correct: [1], multi: false, display: 'bars', resultsHidden: false });
    expect(wrapper.text()).not.toContain('New question');
  });

  it('tells the presenter when a typed correct answer is not an option, and does not send anything', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.section-head .btn')[0].trigger('click');
    const inputs = wrapper.findAll('.card input.input');
    await inputs[0].setValue('Q');
    await inputs[1].setValue('A, B');
    await inputs[2].setValue('Z');
    await btn(wrapper, 'Save question').trigger('click');
    expect(wrapper.find('.alert.error').text()).toContain('Correct answer "Z" is not one of the options');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('edits a question with the form prefilled', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.question')[0].find('.icon-btn').trigger('click');
    expect(wrapper.text()).toContain('Edit question');
    const inputs = wrapper.findAll('.card input.input');
    expect((inputs[0].element as HTMLInputElement).value).toBe('Question 1');
    expect((inputs[1].element as HTMLInputElement).value).toBe('A, B');
    expect((inputs[2].element as HTMLInputElement).value).toBe('A');
    await inputs[0].setValue('Renamed');
    await btn(wrapper, 'Save changes').trigger('click');
    await flushPromises();
    const edit = patchCalls('admin-questions').find((b) => b.edit)!;
    expect(edit).toMatchObject({ questionId: 1, edit: { prompt: 'Renamed', correct: [0], clearVotes: false } });
  });

  it('asks before clearing votes when an edit changes the question shape, then resends with confirmation', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.question')[0].find('.icon-btn').trigger('click');
    await wrapper.findAll('.card input.input')[1].setValue('A, B, C');
    failNext = new FakeApiError('Saving these changes will clear 3 votes on this question.', 409);
    await btn(wrapper, 'Save changes').trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith('Saving these changes will clear 3 votes on this question. Continue?');
    const edits = patchCalls('admin-questions').filter((b) => b.edit);
    expect(edits.map((b) => b.edit.clearVotes)).toEqual([false, true]);
  });

  it('does not clear votes when the presenter declines', async () => {
    window.confirm = vi.fn(() => false);
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.question')[0].find('.icon-btn').trigger('click');
    await wrapper.findAll('.card input.input')[1].setValue('A, B, C');
    failNext = new FakeApiError('Saving these changes will clear 3 votes on this question.', 409);
    await btn(wrapper, 'Save changes').trigger('click');
    await flushPromises();
    expect(patchCalls('admin-questions').filter((b) => b.edit)).toHaveLength(1);
    expect(wrapper.find('.alert.error').text()).toContain('clear 3 votes');
  });

  it('reorders questions by swapping their order indexes', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.question')[0].findAll('.btn').find((b) => b.text().includes('Down'))!.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-questions')).toEqual([
      { questionId: 1, orderIndex: 2 },
      { questionId: 2, orderIndex: 1 },
    ]);
  });

  it('opens the share links and QR codes from the header button in either mode, with the results link using the key', async () => {
    const { wrapper } = await mountPresenter();
    expect(wrapper.findAll('.tab').map((t) => t.text())).toEqual(['Questions (2)', 'Control']);
    expect(wrapper.find('.share-url').exists()).toBe(false);
    await wrapper.find('.app-header .icon-btn').trigger('click');
    expect(wrapper.findAll('.share-url').map((a) => a.text())).toEqual([`${window.location.origin}/vote/STORM01`, `${window.location.origin}/results#key=RESKEY`]);
    expect(wrapper.findAll('.share-card .qr-box')).toHaveLength(2);
    await wrapper.findAll('.modal .btn').find((b) => b.text() === 'Close')!.trigger('click');
    expect(wrapper.find('.share-url').exists()).toBe(false);
    await wrapper.findAll('.seg button')[1].trigger('click');
    await wrapper.find('.app-header .icon-btn').trigger('click');
    expect(wrapper.findAll('.share-url')).toHaveLength(2);
  });

  it('copies the audience link from the share dialog', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.find('.app-header .icon-btn').trigger('click');
    await wrapper.findAll('.share-card .btn')[0].trigger('click');
    await flushPromises();
    expect(copied).toEqual([`${window.location.origin}/vote/STORM01`]);
  });

  it('toggles the join screen and closes or reopens the storm from the Control tab', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    await wrapper.findAll('.toolbar .btn').find((b) => b.text() === 'Show join screen')!.trigger('click');
    await wrapper.findAll('.toolbar .btn').find((b) => b.text() === 'End Storm')!.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toEqual([
      { showConnect: true },
      { status: 'closed' },
    ]);
  });

  it('sets, validates and resets the results background colour from the Control tab', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    const hex = wrapper.find('.bg-hex');
    const reset = wrapper.findAll('.bg-row .btn')[0];
    expect(reset.attributes('disabled')).toBeDefined();

    await hex.setValue('not a colour');
    await hex.trigger('change');
    await flushPromises();
    expect(wrapper.find('.bg-hint').exists()).toBe(true);
    expect(patchCalls('admin-storm')).toEqual([]);

    await hex.setValue('#FF8800');
    await hex.trigger('change');
    await flushPromises();
    expect(patchCalls('admin-storm')).toEqual([{ resultsBackground: '#ff8800' }]);
    expect(wrapper.find('.bg-hint').exists()).toBe(false);
    expect((wrapper.find('.bg-swatch').element as HTMLInputElement).value).toBe('#ff8800');

    await wrapper.findAll('.bg-row .btn')[0].trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')[1]).toEqual({ resultsBackground: null });
  });

  describe('locking voting and the timer', () => {
    async function presentMode() {
      const mounted = await mountPresenter();
      await mounted.wrapper.findAll('.seg button')[1].trigger('click');
      return mounted;
    }
    const voting = (wrapper: ReturnType<typeof mount>) => wrapper.find('.voting-row');
    const rowButtons = (wrapper: ReturnType<typeof mount>) => voting(wrapper).findAll('button').map((b) => b.text());

    it('offers to lock voting and start a timer on the live question', async () => {
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('Voting open');
      expect(rowButtons(wrapper)).toEqual(['Lock voting', '15s', '30s', '1m', '2m', '5m']);

      await btn(wrapper, 'Lock voting').trigger('click');
      await btn(wrapper, '30s').trigger('click');
      await btn(wrapper, '2m').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([
        { questionId: 1, votingLocked: true },
        { questionId: 1, votingSeconds: 30 },
        { questionId: 1, votingSeconds: 120 },
      ]);
    });

    it('shows the countdown while a timer runs, and can add time, lock now or cancel', async () => {
      data.questions[0].voting_ms_left = 20000;
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('0:20 left');
      expect(rowButtons(wrapper)).toEqual(['Lock now', '+30s', 'Cancel timer', '15s', '30s', '1m', '2m', '5m']);

      await btn(wrapper, '+30s').trigger('click');
      await btn(wrapper, 'Cancel timer').trigger('click');
      await btn(wrapper, 'Lock now').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([
        { questionId: 1, votingAddSeconds: 30 },
        { questionId: 1, votingLocked: false },
        { questionId: 1, votingLocked: true },
      ]);
      wrapper.unmount();
    });

    it('says when voting is closed and offers to unlock it', async () => {
      data.questions[0].voting_ms_left = 0;
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('Voting closed');
      expect(rowButtons(wrapper)[0]).toBe('Unlock voting');
      await btn(wrapper, 'Unlock voting').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([{ questionId: 1, votingLocked: false }]);
    });
  });

  it('duplicates the Storm from the Control tab and opens the copy on its Questions tab', async () => {
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    await btn(wrapper, 'Duplicate Storm').trigger('click');
    await flushPromises();
    const call = calls.find((c) => c.path === 'duplicate-storm')!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({});
    expect(call.key).toBe('ADMINKEY');
    expect(router.currentRoute.value.fullPath).toBe('/presenter#key=COPYKEY&tab=questions');
    expect(calls.some((c) => c.path === 'admin-storm' && !c.method && c.key === 'COPYKEY')).toBe(true);
    expect(wrapper.find('.tab.on').text()).toContain('Questions');
  });

  it('shows why a Storm could not be duplicated and stays on the original', async () => {
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    apiMock.mockImplementationOnce(async (path: string, options: RequestInit = {}) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body as string) : undefined, method: options.method });
      throw new FakeApiError('Your license allows 1 active Storm. Delete or let one expire first.', 403);
    });
    await btn(wrapper, 'Duplicate Storm').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert.error').text()).toContain('Your license allows 1 active Storm');
    expect(router.currentRoute.value.fullPath).toContain('/presenter#key=ADMINKEY');
  });

  describe('the admin key', () => {
    it('is sent in a header on every call, and never appears in a URL or a body', async () => {
      const { wrapper } = await mountPresenter();
      await wrapper.findAll('.tab')[1].trigger('click');
      await btn(wrapper, 'Show join screen').trigger('click');
      await btn(wrapper, 'Duplicate Storm').trigger('click');
      await btn(wrapper, 'Delete Storm').trigger('click');
      await flushPromises();
      expect(calls.length).toBeGreaterThan(3);
      for (const call of calls) {
        expect(call.path).not.toContain('ADMINKEY');
        expect(JSON.stringify(call.body ?? {})).not.toContain('ADMINKEY');
      }
      expect(calls.filter((c) => c.path !== 'create-storm').every((c) => c.key === 'ADMINKEY')).toBe(true);
    });

    it('is read from the fragment, and the open tab is kept there too', async () => {
      const { wrapper, router } = await mountPresenter('/presenter#key=ADMINKEY&tab=storm');
      expect(wrapper.find('.tab.on').text()).toContain('Control');
      await wrapper.findAll('.tab')[0].trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.hash).toBe('#key=ADMINKEY&tab=questions');
    });

    it('is remembered on this device once its Storm loads, with the Storm name', async () => {
      data.storm.name = 'Town hall';
      await mountPresenter();
      expect(loadRecent()).toEqual([{ adminKey: 'ADMINKEY', stormCode: 'STORM01', name: 'Town hall', lastOpenedAt: expect.any(Number) }]);
    });

    it('is forgotten when the server says the Storm is gone', async () => {
      rememberStorm({ adminKey: 'ADMINKEY', stormCode: 'STORM01' });
      failNext = null;
      apiMock.mockImplementationOnce(async () => {
        throw new FakeApiError('Invalid admin key', 401);
      });
      const { wrapper } = await mountPresenter();
      expect(wrapper.find('.alert.error').text()).toContain('Invalid admin key');
      expect(loadRecent()).toEqual([]);
    });
  });

  describe('Storm name', () => {
    it('saves a name typed on the Control tab, and shows it in the recent list', async () => {
      const { wrapper } = await mountPresenter();
      await wrapper.findAll('.tab')[1].trigger('click');
      const input = wrapper.find('#storm-name');
      expect((input.element as HTMLInputElement).value).toBe('');
      await input.setValue('  Quarterly review  ');
      await input.trigger('change');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([{ name: 'Quarterly review' }]);
      expect(loadRecent()[0].name).toBe('Quarterly review');
      expect((wrapper.find('#storm-name').element as HTMLInputElement).value).toBe('Quarterly review');
    });

    it('does not send anything when the name has not changed', async () => {
      data.storm.name = 'Same';
      const { wrapper } = await mountPresenter();
      await wrapper.findAll('.tab')[1].trigger('click');
      await wrapper.find('#storm-name').setValue('Same ');
      await wrapper.find('#storm-name').trigger('change');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([]);
    });
  });

  it('shows the license in effect, with its limits, on the Control tab', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    const card = wrapper.findAll('.card').find((c) => c.find('.card-title').exists() && c.find('.card-title').text() === 'License')!;
    expect(card.text()).toContain('Acme');
    expect(card.text()).toContain('2 days of inactivity');
    expect(card.text()).toContain('25');
    expect(card.find('a').attributes('href')).toBe('/license');
  });

  it('confirms before deleting the storm and returns to the presenter home', async () => {
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    await btn(wrapper, 'Delete Storm').trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith('Delete this Storm? This cannot be undone.');
    expect(calls.some((c) => c.path === 'admin-storm' && c.method === 'DELETE')).toBe(true);
    expect(router.currentRoute.value.fullPath).toBe('/presenter');
  });

  it('updates a question live from tally events, and reloads when its results are hidden', async () => {
    const { wrapper } = await mountPresenter();
    channel.handlers.tally({ questionId: 1, counts: [5, 0], totalVotes: 5 });
    await flushPromises();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(wrapper.find('.present-count').text()).toBe('5');
    const before = calls.filter((c) => c.path === 'admin-storm' && !c.method).length;
    channel.handlers.tally({ questionId: 1, totalVotes: 6, hidden: true });
    await flushPromises();
    expect(calls.filter((c) => c.path === 'admin-storm' && !c.method).length).toBe(before + 1);
  });

  it('offers to create a storm when there is no admin key', async () => {
    const { wrapper, router } = await mountPresenter('/presenter');
    expect(wrapper.text()).toContain('No Storm yet');
    await wrapper.find('.btn.primary').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/presenter#key=NEWKEY');
    expect(calls.some((c) => c.path === 'create-storm')).toBe(true);
  });
});
