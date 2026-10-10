// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { AdminCloud, AdminStormData } from '@/shared/types';
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

const SECRET = 'a'.repeat(128);
const NEW_SECRET = 'b'.repeat(128);
const COPY_SECRET = 'c'.repeat(128);

const calls: { path: string; body: any; method?: string; session?: { stormCode: string; secret: string } }[] = [];
let data: AdminStormData;
let failNext: Error | null = null;
let dataFor: Record<string, AdminStormData> = {};

const apiMock = vi.fn(async (session: { stormCode: string; secret: string }, path: string, options: RequestInit = {}) => {
  const body = options.body ? JSON.parse(options.body as string) : undefined;
  calls.push({ path, body, method: options.method, session });
  if (failNext && options.method === 'PATCH') {
    const err = failNext;
    failNext = null;
    throw err;
  }
  if (path === 'admin-storm' && !options.method) return JSON.parse(JSON.stringify(dataFor[session.stormCode] ?? data));
  if (path === 'admin-storm' && options.method === 'PATCH' && body.currentCloudId) {
    data.storm.current_cloud_id = body.currentCloudId;
    data.storm.status = 'active';
  }
  if (path === 'admin-storm' && options.method === 'PATCH' && body.cloudId && body.resultsHidden !== undefined) {
    data.clouds.find((q) => q.id === body.cloudId)!.results_hidden = body.resultsHidden ? 1 : 0;
  }
  if (path === 'duplicate-storm') return { stormCode: 'COPY0001' };
  return { ok: true };
});
vi.mock('@/api', () => ({ api: vi.fn(), getDeviceId: () => 'd', ApiError: FakeApiError }));
vi.mock('@/lib/adminRequest', () => ({ signedApi: (...a: [any, string, RequestInit?]) => apiMock(...a) }));

const createStormMock = vi.fn(async () => ({ stormCode: 'NEW00001', secret: NEW_SECRET }));
vi.mock('@/lib/createStorm', () => ({ createStorm: () => createStormMock() }));

vi.mock('@/lib/adminKeys', () => ({
  describeSecret: async () => ({ secret: 'x', publicKey: 'PUB', resultsKey: 'RESKEY', resultsKeyHash: 'HASH' }),
  generateAdminSecret: async () => ({ secret: COPY_SECRET, publicKey: 'COPYPUB', resultsKey: 'COPYRES', resultsKeyHash: 'COPYHASH' }),
}));

const channel = { handlers: {} as Record<string, (d: any) => void>, close: vi.fn(), subscriptions: [] as { code: string; close: ReturnType<typeof vi.fn> }[] };
vi.mock('@/composables/useStormChannel', () => ({
  subscribeStorm: (code: string, handlers: Record<string, (d: any) => void>) => {
    channel.handlers = handlers;
    const close = vi.fn();
    channel.subscriptions.push({ code, close });
    return { close: (...a: unknown[]) => (channel.close(...a), close()) };
  },
}));

const copied: string[] = [];
vi.mock('@/composables/useClipboard', () => ({ copyText: async (t: string) => (copied.push(t), true) }));

import PresenterView from '@/views/PresenterView.vue';

const cloud = (id: number, over: Partial<AdminCloud> = {}): AdminCloud => ({
  id, storm_code: 'ABCDEFGH', order_index: id, kind: 'choice', body: `Cloud ${id}`, options: JSON.stringify(['A', 'B']),
  scale_min: null, scale_max: null, multi: 0, results_hidden: 0, answer_shown: 0, correct: null, display: 'bars',
  max_words: null, hidden_words: null, tally: { counts: [2, 1], totalVotes: 3 }, ...over,
});

async function mountPresenter(url = `/presenter/ABCDEFGH#k=${SECRET}`) {
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
    dataFor = {};
    channel.subscriptions.length = 0;
    channel.close.mockClear();
    apiMock.mockClear();
    createStormMock.mockClear();
    localStorage.clear();
    window.confirm = vi.fn(() => true);
    window.scrollTo = vi.fn();
    data = {
      storm: { storm_code: 'ABCDEFGH', status: 'active', current_cloud_id: 1 },
      clouds: [cloud(1, { correct: JSON.stringify([0]) }), cloud(2, { kind: 'choice', display: 'donut', results_hidden: 1 })],
      showConnect: false,
      license: { tier: 'licensed', name: 'Acme', expiresAt: null, limits: { stormInactivityHours: 48, maxQuestionsPerStorm: 25 } },
    };
  });

  it('starts in Edit mode showing cloud setup, not results', async () => {
    const { wrapper } = await mountPresenter();
    expect(wrapper.find('.seg button.on').text()).toBe('Edit');
    const cards = wrapper.findAll('.cloud');
    expect(cards).toHaveLength(2);
    expect(cards[0].classes()).toContain('active');
    expect(cards[0].text()).toContain('Cloud 1');
    expect(cards[0].findAll('.chip').map((c) => c.text())).toEqual(['A ✓', 'B']);
    expect(cards[1].text()).toContain('Donut');
    expect(cards[1].text()).toContain('Results hidden');
    expect(wrapper.find('.cloud .sbar').exists()).toBe(false);
    expect(wrapper.find('.tabs').text()).toContain('Clouds (2)');
  });

  it('Present mode shows the live results and controls, remembers the mode, and Next advances the cloud', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(localStorage.getItem('votestorm_mode')).toBe('present');
    const now = wrapper.find('.present-now');
    expect(now.text()).toContain('Cloud 1');
    expect(now.findAll('.sbar')).toHaveLength(2);
    expect(wrapper.find('.present-nav .btn.primary').text()).toContain('Next');
    await wrapper.find('.present-nav .btn.primary').trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ status: 'active', currentCloudId: 2 });
    expect(wrapper.find('.present-now').text()).toContain('Cloud 2');
    expect(wrapper.findAll('.present-row')[1].classes()).toContain('live');
  });

  it('opens in Present mode when that was the last mode used', async () => {
    localStorage.setItem('votestorm_mode', 'present');
    const { wrapper } = await mountPresenter();
    expect(wrapper.find('.seg button.on').text()).toBe('Present');
  });

  it('shows the hidden results to the presenter with a note, and toggles them per cloud', async () => {
    data.storm.current_cloud_id = 2;
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(wrapper.find('.present-now').text()).toContain('hidden from the audience');
    expect(wrapper.find('.present-now .donut').exists()).toBe(true);
    const toggle = wrapper.findAll('.present-now .toolbar .btn').find((b) => b.text() === 'Show results')!;
    await toggle.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ cloudId: 2, resultsHidden: false });
  });

  it('keeps the live controls above the results so they stay on screen with a long scale', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    const html = wrapper.find('.present-now').html();
    expect(html.indexOf('Hide results')).toBeGreaterThan(-1);
    expect(html.indexOf('Hide results')).toBeLessThan(html.indexOf('sbar'));
    expect(wrapper.find('.present-now .slide-total').exists()).toBe(false);
  });

  it('reveals the correct answer for the live cloud', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.seg button')[1].trigger('click');
    await wrapper.findAll('.present-now .toolbar .btn').find((b) => b.text() === 'Reveal answer')!.trigger('click');
    expect(patchCalls('admin-storm')).toContainEqual({ cloudId: 1, answerShown: true });
  });

  it('activates a cloud from its Edit card', async () => {
    const { wrapper } = await mountPresenter();
    const card = wrapper.findAll('.cloud')[1];
    await card.findAll('.btn').find((b) => b.text() === 'Activate')!.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-storm')).toContainEqual({ status: 'active', currentCloudId: 2 });
  });

  it('copies a results link built from the results key, not the storm code', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.cloud')[1].findAll('.btn').find((b) => b.text() === 'Copy results link')!.trigger('click');
    await flushPromises();
    expect(copied).toEqual([`${window.location.origin}/results#k=RESKEY&c=2`]);
  });

  it('adds a cloud, mapping the typed correct answer to its index', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.section-head .btn')[0].trigger('click');
    const inputs = wrapper.findAll('.card input.input');
    await wrapper.find('.card textarea').setValue('Best pet?');
    await inputs[0].setValue('Cat, Dog');
    await inputs[1].setValue('dog');
    await btn(wrapper, 'Save cloud').trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.path === 'admin-clouds' && c.method === 'POST')!;
    expect(post.body).toMatchObject({ kind: 'choice', body: 'Best pet?', options: ['Cat', 'Dog'], correct: [1], multi: false, display: 'bars', resultsHidden: false });
    expect(wrapper.text()).not.toContain('New cloud');
  });

  it('tells the presenter when a typed correct answer is not an option, and does not send anything', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.section-head .btn')[0].trigger('click');
    const inputs = wrapper.findAll('.card input.input');
    await wrapper.find('.card textarea').setValue('Q');
    await inputs[0].setValue('A, B');
    await inputs[1].setValue('Z');
    await btn(wrapper, 'Save cloud').trigger('click');
    expect(wrapper.find('.alert.error').text()).toContain('Correct answer "Z" is not one of the options');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('edits a cloud with the form prefilled', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.cloud')[0].find('.icon-btn').trigger('click');
    expect(wrapper.text()).toContain('Edit cloud');
    const inputs = wrapper.findAll('.card input.input');
    expect((wrapper.find('.card textarea').element as HTMLTextAreaElement).value).toBe('Cloud 1');
    expect((inputs[0].element as HTMLInputElement).value).toBe('A, B');
    expect((inputs[1].element as HTMLInputElement).value).toBe('A');
    await wrapper.find('.card textarea').setValue('Renamed');
    await btn(wrapper, 'Save cloud').trigger('click');
    await flushPromises();
    const edit = patchCalls('admin-clouds').find((b) => b.edit)!;
    expect(edit).toMatchObject({ cloudId: 1, edit: { body: 'Renamed', correct: [0], clearVotes: false } });
  });

  it('asks before clearing votes when an edit changes the cloud shape, then resends with confirmation', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.cloud')[0].find('.icon-btn').trigger('click');
    await wrapper.findAll('.card input.input')[0].setValue('A, B, C');
    failNext = new FakeApiError('Saving these changes will clear 3 votes on this cloud.', 409);
    await btn(wrapper, 'Save cloud').trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith('Saving these changes will clear 3 votes on this cloud. Continue?');
    const edits = patchCalls('admin-clouds').filter((b) => b.edit);
    expect(edits.map((b) => b.edit.clearVotes)).toEqual([false, true]);
  });

  it('does not clear votes when the presenter declines', async () => {
    window.confirm = vi.fn(() => false);
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.cloud')[0].find('.icon-btn').trigger('click');
    await wrapper.findAll('.card input.input')[0].setValue('A, B, C');
    failNext = new FakeApiError('Saving these changes will clear 3 votes on this cloud.', 409);
    await btn(wrapper, 'Save cloud').trigger('click');
    await flushPromises();
    expect(patchCalls('admin-clouds').filter((b) => b.edit)).toHaveLength(1);
    expect(wrapper.find('.alert.error').text()).toContain('clear 3 votes');
  });

  it('reorders clouds by swapping their order indexes', async () => {
    const { wrapper } = await mountPresenter();
    await wrapper.findAll('.cloud')[0].findAll('.btn').find((b) => b.text().includes('Down'))!.trigger('click');
    await flushPromises();
    expect(patchCalls('admin-clouds')).toEqual([
      { cloudId: 1, orderIndex: 2 },
      { cloudId: 2, orderIndex: 1 },
    ]);
  });

  it('opens the share links and QR codes from the header button in either mode, with the results link using the derived key', async () => {
    const { wrapper } = await mountPresenter();
    expect(wrapper.findAll('.tab').map((t) => t.text())).toEqual(['Clouds (2)', 'Control']);
    expect(wrapper.find('.share-url').exists()).toBe(false);
    await wrapper.find('.app-header .icon-btn').trigger('click');
    expect(wrapper.findAll('.share-url').map((a) => a.text())).toEqual([`${window.location.origin}/vote/ABCDEFGH`, `${window.location.origin}/results#k=RESKEY`]);
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
    expect(copied).toEqual([`${window.location.origin}/vote/ABCDEFGH`]);
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

  describe('cloud kinds', () => {
    const openForm = async () => {
      const mounted = await mountPresenter();
      await mounted.wrapper.findAll('.section-head .btn')[0].trigger('click');
      return mounted;
    };
    const present = async (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.seg button')[1].trigger('click');

    it('offers Choice, Rating, Words and Content, and Content shows only the markdown box with a preview and counter', async () => {
      const { wrapper } = await openForm();
      const select = wrapper.find('.card select.input');
      expect(select.findAll('option').map((o) => o.text())).toEqual(['Choice', 'Rating scale', 'Words', 'Content']);
      await select.setValue('content');
      const text = wrapper.find('.cloud-form').text();
      for (const gone of ['Options (comma separated)', 'Correct answer', 'Live results display', 'Allow multiple answers', 'Min', 'Max', 'Hide results until I show them', 'Words per person']) {
        expect(text).not.toContain(gone);
      }
      expect(wrapper.find('.cloud-form').text()).toContain('Text (markdown)');
      expect(wrapper.find('.card textarea').attributes('maxlength')).toBe('4000');
      await wrapper.find('.card textarea').setValue('**Hi**');
      expect(wrapper.find('.card .form-counter').text()).toBe('6 / 4000');
      await vi.waitFor(() => expect(wrapper.find('.card .form-preview strong').text()).toBe('Hi'));
      await btn(wrapper, 'Save cloud').trigger('click');
      await flushPromises();
      expect(calls.find((c) => c.path === 'admin-clouds' && c.method === 'POST')!.body).toEqual({ kind: 'content', body: '**Hi**' });
    });

    it('Words asks for words per person (default 3) and sends it', async () => {
      const { wrapper } = await openForm();
      await wrapper.find('.card select.input').setValue('words');
      const input = wrapper.find('.card input[type=number]');
      expect(wrapper.find('.cloud-form').text()).toContain('Words per person');
      expect((input.element as HTMLInputElement).value).toBe('3');
      await input.setValue('5');
      await wrapper.find('.card textarea').setValue('One word');
      await btn(wrapper, 'Save cloud').trigger('click');
      await flushPromises();
      expect(calls.find((c) => c.path === 'admin-clouds' && c.method === 'POST')!.body).toEqual({ kind: 'words', body: 'One word', maxWords: 5, resultsHidden: false });
    });

    it('gives a Choice cloud the same markdown box and preview', async () => {
      const { wrapper } = await openForm();
      expect(wrapper.find('.cloud-form').text()).toContain('Text (markdown)');
      expect(wrapper.find('.cloud-form').text()).not.toContain('Prompt');
      expect(wrapper.find('.card .form-preview').exists()).toBe(true);
    });

    it('shows content and words cards with the right badges and actions', async () => {
      data.clouds = [
        cloud(3, { kind: 'content', body: '**Bold** idea', options: null, display: null, tally: { totalVotes: 0 } as never }),
        cloud(4, { kind: 'words', body: 'Words please', options: null, display: null, max_words: 3, tally: { words: [], totalVotes: 0 } as never }),
      ];
      data.storm.current_cloud_id = 3;
      const { wrapper } = await mountPresenter();
      const [content, words] = wrapper.findAll('.cloud');
      await vi.waitFor(() => expect(content.find('.q-prompt.clamp strong').text()).toBe('Bold'));
      expect(content.find('.badge').text()).toBe('Content');
      const contentButtons = content.findAll('.btn').map((b) => b.text());
      expect(contentButtons).not.toContain('Reset votes');
      expect(contentButtons).not.toContain('Copy results link');
      expect(words.find('.badge').text()).toBe('Words (up to 3)');
      expect(words.text()).toContain('People send up to 3 words');
      expect(words.findAll('.btn').map((b) => b.text())).toContain('Reset votes');
    });

    describe('Present panel', () => {
      const voting = (wrapper: ReturnType<typeof mount>) => wrapper.find('.voting-row');
      const rowButtons = (wrapper: ReturnType<typeof mount>) => voting(wrapper).findAll('button').map((b) => b.text());
      const contentCloud = (over: Partial<AdminCloud> = {}) =>
        cloud(3, { kind: 'content', body: '**Big** idea', options: null, display: null, tally: { totalVotes: 0 } as never, ...over });
      const CHIPS = ['15s', '30s', '1m', '2m', '5m'];

      it('a live content cloud has no response count, results toggles or lock buttons, only the timer', async () => {
        data.clouds = [contentCloud()];
        data.storm.current_cloud_id = 3;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        const now = wrapper.find('.present-now');
        await vi.waitFor(() => expect(now.find('.present-prompt strong').text()).toBe('Big'));
        expect(now.find('.present-count').exists()).toBe(false);
        const all = now.findAll('button').map((b) => b.text());
        for (const gone of ['Hide results', 'Show results', 'Reveal answer', 'Lock voting', 'Lock now', 'Unlock voting']) expect(all).not.toContain(gone);
        expect(voting(wrapper).find('.voting-state').text()).toBe('No timer');
        expect(rowButtons(wrapper)).toEqual(CHIPS);
      });

      it('labels the live body with its own hidden h2 and never nests the body\'s headings in a heading', async () => {
        data.clouds = [contentCloud({ body: '# Title\n\nText' })];
        data.storm.current_cloud_id = 3;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        const now = wrapper.find('.present-now');
        await vi.waitFor(() => expect(now.find('.present-prompt h2').text()).toBe('Title'));
        expect(now.find('h2.sr-only').text()).toBe('Current cloud');
        expect(now.find('[role=heading]').exists()).toBe(false);
      });

      it('shows a running timer with +30s and Clear timer', async () => {
        data.clouds = [contentCloud({ voting_ms_left: 20000 })];
        data.storm.current_cloud_id = 3;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        expect(voting(wrapper).find('.voting-state').text()).toBe('0:20 left');
        expect(rowButtons(wrapper)).toEqual(['+30s', 'Clear timer', ...CHIPS]);
        await btn(wrapper, 'Clear timer').trigger('click');
        await flushPromises();
        // clearTimer marks the request so the activity notice says "Timer cleared" rather than "Voting open".
        expect(patchCalls('admin-storm')).toEqual([{ cloudId: 3, votingLocked: false, clearTimer: true }]);
        wrapper.unmount();
      });

      it('says "Time\'s up" with Clear timer once the timer has run out', async () => {
        data.clouds = [contentCloud({ voting_ms_left: 0 })];
        data.storm.current_cloud_id = 3;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        expect(voting(wrapper).find('.voting-state').text()).toBe("Time's up");
        expect(rowButtons(wrapper)[0]).toBe('Clear timer');
      });

      it('puts the word moderation list before the word cloud so removing a word needs no scrolling', async () => {
        data.clouds = [cloud(4, {
          kind: 'words', body: 'W', options: null, display: null, max_words: 3, hidden_words: JSON.stringify(['gone']),
          tally: { words: [{ word: 'calm', count: 3 }], totalVotes: 3 } as never,
        })];
        data.storm.current_cloud_id = 4;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        const list = wrapper.find('.present-now [aria-label="Words sent"]').element;
        const removed = wrapper.find('.present-now [aria-label="Removed words"]').element;
        const cloudEl = wrapper.find('.present-now .word-cloud').element;
        expect(list.compareDocumentPosition(cloudEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(list.compareDocumentPosition(removed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(removed.compareDocumentPosition(cloudEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });

      it('a live words cloud lists its words for removal and reads Submissions open', async () => {
        data.clouds = [cloud(4, {
          kind: 'words', body: 'Words please', options: null, display: null, max_words: 3, hidden_words: JSON.stringify(['gone']),
          tally: { words: [{ word: 'calm', count: 3 }, { word: 'rude', count: 1 }], totalVotes: 4 } as never,
        })];
        data.storm.current_cloud_id = 4;
        const { wrapper } = await mountPresenter();
        await present(wrapper);
        const now = wrapper.find('.present-now');
        expect(voting(wrapper).find('.voting-state').text()).toBe('Submissions open');
        expect(rowButtons(wrapper)[0]).toBe('Lock submissions');
        expect(now.find('[aria-label="Restore gone"]').exists()).toBe(true);
        await now.find('[aria-label="Remove rude"]').trigger('click');
        await flushPromises();
        expect(patchCalls('admin-clouds')).toEqual([{ cloudId: 4, hideWord: 'rude' }]);
        // The words marker makes the activity notice say "Submissions locked" (the server ignores it).
        await btn(wrapper, 'Lock submissions').trigger('click');
        await flushPromises();
        expect(patchCalls('admin-storm')).toEqual([{ cloudId: 4, votingLocked: true, words: true }]);
      });
    });

    it.each([
      ['content', { kind: 'content', body: 'Cloud 1' }],
      ['words', { kind: 'words', body: 'Cloud 1', maxWords: 3 }],
    ])('asks before clearing votes when a Choice cloud with responses becomes %s, then retries with clearVotes', async (kind, expected) => {
      const { wrapper } = await mountPresenter();
      await wrapper.findAll('.cloud')[0].find('.icon-btn').trigger('click');
      await wrapper.find('.card select.input').setValue(kind);
      failNext = new FakeApiError('Saving these changes will clear 3 votes on this cloud.', 409);
      await btn(wrapper, 'Save cloud').trigger('click');
      await flushPromises();
      expect(window.confirm).toHaveBeenCalledWith('Saving these changes will clear 3 votes on this cloud. Continue?');
      const edits = patchCalls('admin-clouds').filter((b) => b.edit);
      expect(edits.map((b) => b.edit.clearVotes)).toEqual([false, true]);
      expect(edits[1].edit).toMatchObject(expected);
    });
  });

  describe('locking voting and the timer', () => {
    async function presentMode() {
      const mounted = await mountPresenter();
      await mounted.wrapper.findAll('.seg button')[1].trigger('click');
      return mounted;
    }
    const voting = (wrapper: ReturnType<typeof mount>) => wrapper.find('.voting-row');
    const rowButtons = (wrapper: ReturnType<typeof mount>) => voting(wrapper).findAll('button').map((b) => b.text());

    it('offers to lock voting and start a timer on the live cloud', async () => {
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('Voting open');
      expect(rowButtons(wrapper)).toEqual(['Lock voting', '15s', '30s', '1m', '2m', '5m']);

      await btn(wrapper, 'Lock voting').trigger('click');
      await btn(wrapper, '30s').trigger('click');
      await btn(wrapper, '2m').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([
        { cloudId: 1, votingLocked: true },
        { cloudId: 1, votingSeconds: 30 },
        { cloudId: 1, votingSeconds: 120 },
      ]);
    });

    it('shows the countdown while a timer runs, and can add time, lock now or cancel', async () => {
      data.clouds[0].voting_ms_left = 20000;
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('0:20 left');
      expect(rowButtons(wrapper)).toEqual(['Lock now', '+30s', 'Cancel timer', '15s', '30s', '1m', '2m', '5m']);

      await btn(wrapper, '+30s').trigger('click');
      await btn(wrapper, 'Cancel timer').trigger('click');
      await btn(wrapper, 'Lock now').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([
        { cloudId: 1, votingAddSeconds: 30 },
        { cloudId: 1, votingLocked: false },
        { cloudId: 1, votingLocked: true },
      ]);
      wrapper.unmount();
    });

    it('says when voting is closed and offers to unlock it', async () => {
      data.clouds[0].voting_ms_left = 0;
      const { wrapper } = await presentMode();
      expect(voting(wrapper).find('.voting-state').text()).toBe('Voting closed');
      expect(rowButtons(wrapper)[0]).toBe('Unlock voting');
      await btn(wrapper, 'Unlock voting').trigger('click');
      await flushPromises();
      expect(patchCalls('admin-storm')).toEqual([{ cloudId: 1, votingLocked: false }]);
    });
  });

  it('does not open a live connection when the page is closed while the Storm is still loading', async () => {
    let release!: (value: AdminStormData) => void;
    apiMock.mockImplementationOnce(() => new Promise<AdminStormData>((resolve) => (release = resolve)));
    const { wrapper } = await mountPresenter();
    expect(channel.subscriptions).toHaveLength(0);

    wrapper.unmount();
    release(JSON.parse(JSON.stringify(data)));
    await flushPromises();

    expect(channel.subscriptions).toHaveLength(0);
    expect(loadRecent()).toEqual([]);
  });

  it('duplicates the Storm from the Control tab and opens the copy on its Clouds tab', async () => {
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    await btn(wrapper, 'Duplicate Storm').trigger('click');
    await flushPromises();
    const call = calls.find((c) => c.path === 'duplicate-storm')!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ publicKey: 'COPYPUB', resultsKeyHash: 'COPYHASH' });
    expect(JSON.stringify(call.body)).not.toContain(SECRET);
    expect(JSON.stringify(call.body)).not.toContain(COPY_SECRET);
    expect(call.session).toEqual({ stormCode: 'ABCDEFGH', secret: SECRET });
    expect(router.currentRoute.value.fullPath).toBe(`/presenter/COPY0001#k=${COPY_SECRET}&t=clouds`);
    expect(calls.some((c) => c.path === 'admin-storm' && !c.method && c.session?.stormCode === 'COPY0001' && c.session.secret === COPY_SECRET)).toBe(true);
    expect(wrapper.find('.tab.on').text()).toContain('Clouds');
  });

  it('goes back to the source Storm after Duplicate and Back: reloads it, signs for it, and closes the copy subscription', async () => {
    dataFor = { COPY0001: { ...data, storm: { ...data.storm, storm_code: 'COPY0001', name: 'The copy' }, clouds: [cloud(9, { body: 'Copied cloud', storm_code: 'COPY0001' })] } };
    data.storm.name = 'The source';
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    await btn(wrapper, 'Duplicate Storm').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Copied cloud');
    expect(wrapper.text()).not.toContain('Cloud 1');
    const [sourceSub, copySub] = channel.subscriptions;
    expect(channel.subscriptions.map((s) => s.code)).toEqual(['ABCDEFGH', 'COPY0001']);
    expect(sourceSub.close).toHaveBeenCalledTimes(1);

    calls.length = 0;
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.params.stormCode).toBe('ABCDEFGH');
    const loads = calls.filter((c) => c.path === 'admin-storm' && !c.method);
    expect(loads).toHaveLength(1);
    expect(loads[0].session).toEqual({ stormCode: 'ABCDEFGH', secret: SECRET });
    expect(wrapper.text()).toContain('Cloud 1');
    expect(wrapper.text()).not.toContain('Copied cloud');
    expect(copySub.close).toHaveBeenCalledTimes(1);
    expect(channel.subscriptions.map((s) => s.code)).toEqual(['ABCDEFGH', 'COPY0001', 'ABCDEFGH']);

    calls.length = 0;
    await wrapper.findAll('.tab')[1].trigger('click');
    await btn(wrapper, 'Show join screen').trigger('click');
    await flushPromises();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.session).toEqual({ stormCode: 'ABCDEFGH', secret: SECRET });
  });

  it('clears the Storm and its subscription when the link stops naming one', async () => {
    const { wrapper, router } = await mountPresenter();
    await router.push('/presenter');
    await flushPromises();
    expect(channel.subscriptions[0].close).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('No Storm yet');
    expect(wrapper.text()).not.toContain('Cloud 1');
  });

  it('shows why a Storm could not be duplicated and stays on the original', async () => {
    const { wrapper, router } = await mountPresenter();
    await wrapper.findAll('.tab')[1].trigger('click');
    apiMock.mockImplementationOnce(async (session: any, path: string, options: RequestInit = {}) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body as string) : undefined, method: options.method, session });
      throw new FakeApiError('Your license allows 1 active Storm. Delete or let one expire first.', 403);
    });
    await btn(wrapper, 'Duplicate Storm').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert.error').text()).toContain('Your license allows 1 active Storm');
    expect(router.currentRoute.value.fullPath).toContain(`/presenter/ABCDEFGH#k=${SECRET}`);
  });

  describe('the presenter secret', () => {
    it('signs every call as the Storm in the path with the secret in the fragment, and never puts the secret in a function name or body', async () => {
      const { wrapper } = await mountPresenter();
      await wrapper.findAll('.tab')[1].trigger('click');
      await btn(wrapper, 'Show join screen').trigger('click');
      await btn(wrapper, 'Duplicate Storm').trigger('click');
      await btn(wrapper, 'Delete Storm').trigger('click');
      await flushPromises();
      expect(calls.length).toBeGreaterThan(3);
      for (const call of calls) {
        expect(call.path).not.toContain('?');
        expect(call.path).not.toContain(SECRET);
        expect(JSON.stringify(call.body ?? {})).not.toContain(SECRET);
      }
      const original = calls.filter((c) => c.path !== 'admin-storm' || c.session?.stormCode === 'ABCDEFGH');
      expect(original.every((c) => c.session!.stormCode === 'ABCDEFGH' && c.session!.secret === SECRET)).toBe(true);
    });

    it('is read from the fragment, and the open tab is kept there too', async () => {
      const { wrapper, router } = await mountPresenter(`/presenter/ABCDEFGH#k=${SECRET}&t=storm`);
      expect(wrapper.find('.tab.on').text()).toContain('Control');
      await wrapper.findAll('.tab')[0].trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.hash).toBe(`#k=${SECRET}&t=clouds`);
    });

    it('is remembered on this device once its Storm loads, with the Storm name', async () => {
      data.storm.name = 'Town hall';
      await mountPresenter();
      expect(loadRecent()).toEqual([{ stormCode: 'ABCDEFGH', secret: SECRET, name: 'Town hall', lastOpenedAt: expect.any(Number) }]);
    });

    it('is forgotten when the server says the Storm is gone', async () => {
      rememberStorm({ stormCode: 'ABCDEFGH', secret: SECRET });
      failNext = null;
      apiMock.mockImplementationOnce(async () => {
        throw new FakeApiError('Invalid admin key', 401);
      });
      const { wrapper } = await mountPresenter();
      expect(wrapper.find('.alert.error').text()).toContain('Invalid admin key');
      expect(loadRecent()).toEqual([]);
    });

    it('is kept, with the error shown, when the clock is out of step with the server', async () => {
      rememberStorm({ stormCode: 'ABCDEFGH', secret: SECRET });
      apiMock.mockImplementationOnce(async () => {
        throw Object.assign(new FakeApiError('This device’s clock is out of step with the server', 401), { code: 'clock_skew' });
      });
      const { wrapper } = await mountPresenter();
      expect(wrapper.find('.alert.error').text()).toContain('clock is out of step');
      expect(loadRecent().map((e) => e.stormCode)).toEqual(['ABCDEFGH']);
    });

    it('is reported missing, without any admin request, when the link has a code but no key', async () => {
      const { wrapper } = await mountPresenter('/presenter/ABCDEFGH');
      expect(wrapper.text()).toContain('This link is missing its key');
      expect(wrapper.text()).not.toContain('No Storm yet');
      expect(calls).toEqual([]);
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

  it('updates a cloud live from tally events, and reloads when its results are hidden', async () => {
    const { wrapper } = await mountPresenter();
    channel.handlers.tally({ cloudId: 1, counts: [5, 0], totalVotes: 5 });
    await flushPromises();
    await wrapper.findAll('.seg button')[1].trigger('click');
    expect(wrapper.find('.present-count').text()).toBe('5');
    const before = calls.filter((c) => c.path === 'admin-storm' && !c.method).length;
    channel.handlers.tally({ cloudId: 1, totalVotes: 6, hidden: true });
    await flushPromises();
    expect(calls.filter((c) => c.path === 'admin-storm' && !c.method).length).toBe(before + 1);
  });

  it('offers to create a storm when there is no Storm code, then opens it with its secret and remembers it', async () => {
    const { wrapper, router } = await mountPresenter('/presenter');
    expect(wrapper.text()).toContain('No Storm yet');
    await wrapper.find('.btn.primary').trigger('click');
    await flushPromises();
    expect(createStormMock).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.fullPath).toBe(`/presenter/NEW00001#k=${NEW_SECRET}`);
    expect(loadRecent().map((e) => [e.stormCode, e.secret])).toEqual([['NEW00001', NEW_SECRET]]);
  });
});
