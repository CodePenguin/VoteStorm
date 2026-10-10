// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { Cloud, StormState } from '@/shared/types';

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

const channel = { code: '', handlers: {} as Record<string, (d: any) => void>, close: vi.fn() };
vi.mock('@/composables/useStormChannel', () => ({
  subscribeStorm: (code: string, handlers: Record<string, (d: any) => void>) => {
    channel.code = code;
    channel.handlers = handlers;
    return { close: channel.close };
  },
}));

import VoteView from '@/views/VoteView.vue';

const choice: Cloud = {
  id: 7, kind: 'choice', body: 'Favourite fruit?', options: ['Apple', 'Banana', 'Cherry'], scaleMin: null, scaleMax: null,
  multi: false, display: 'bars', resultsHidden: false, correct: null, maxWords: null,
};

function state(overrides: Partial<StormState> = {}): StormState {
  return { status: 'active', currentCloud: choice, tally: { counts: [0, 0, 0], totalVotes: 0 }, showConnect: false, ...overrides };
}

let voteReply: unknown = { ok: true };

async function mountVote(stormState: StormState, attachTo?: HTMLElement) {
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith('get-storm-state')) return stormState;
    if (path.startsWith('vote')) return voteReply;
    throw new Error('unexpected ' + path);
  });
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push('/vote/STORM01');
  await router.isReady();
  const wrapper = mount(VoteView, { global: { plugins: [router] }, attachTo });
  await flushPromises();
  return wrapper;
}

describe('VoteView', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    voteReply = { ok: true };
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });

  it('accepts a spaced or lower-case code and uses the stored form for requests and the channel', async () => {
    apiMock.mockImplementation(async () => state());
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/vote/abcd-efgh');
    await router.isReady();
    mount(VoteView, { global: { plugins: [router] } });
    await flushPromises();
    expect(apiMock.mock.calls.map((c) => c[0])).toContain('get-storm-state?stormCode=ABCDEFGH');
    expect(channel.code).toBe('ABCDEFGH');
  });

  it('waits when no cloud is live', async () => {
    const wrapper = await mountVote(state({ currentCloud: null, tally: null }));
    expect(wrapper.text()).toContain('Waiting for the next cloud');
  });

  describe('locked and timed voting', () => {
    const timed = (ms: number | null) => state({ currentCloud: { ...choice, votingMsLeft: ms } });

    it('shows the time left while voting is open, and still takes votes', async () => {
      const wrapper = await mountVote(timed(45000));
      expect(wrapper.find('.voting-clock').text()).toBe('0:45 left');
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      wrapper.unmount();
    });

    it('does not show a clock for a cloud with no timer', async () => {
      const wrapper = await mountVote(timed(null));
      expect(wrapper.find('.voting-clock').exists()).toBe(false);
    });

    it('shows results instead of choices once voting is closed, for someone who has not voted', async () => {
      const wrapper = await mountVote(timed(0));
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.text()).toContain('no longer taking votes');
      expect(wrapper.findAll('.choice')).toHaveLength(0);
      expect(wrapper.text()).not.toContain('Change my vote');
      expect(wrapper.find('.slide-card').exists()).toBe(true);
    });

    it('keeps a voter\'s answer but takes away "Change my vote" once closed', async () => {
      localStorage.setItem('votestorm_voted_STORM01_7', '1');
      const wrapper = await mountVote(timed(0));
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.text()).toContain('Your vote is in.');
      expect(wrapper.text()).not.toContain('Change my vote');
    });

    it('closes the cloud live when the presenter locks it', async () => {
      const wrapper = await mountVote(timed(null));
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      channel.handlers.state({ status: 'active', currentCloud: { ...choice, votingMsLeft: 0 }, initialTally: { counts: [0, 0, 0], totalVotes: 0 }, showConnect: false });
      await flushPromises();
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.findAll('.choice')).toHaveLength(0);
    });

    it('believes the server when it refuses a vote because voting has closed', async () => {
      const wrapper = await mountVote(timed(60000));
      apiMock.mockImplementation(async () => {
        throw Object.assign(new Error('Voting has closed for this cloud.'), { code: 'voting_closed' });
      });
      await wrapper.findAll('.choice')[0].trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.findAll('.choice')).toHaveLength(0);
      wrapper.unmount();
    });
  });

  it('shows a single-choice cloud and submits a vote with the device id', async () => {
    const wrapper = await mountVote(state());
    expect(wrapper.text()).toContain('Favourite fruit?');
    await wrapper.findAll('.choice')[1].trigger('click');
    await flushPromises();
    const call = apiMock.mock.calls.find((c) => c[0] === 'vote')!;
    expect(JSON.parse(call[1].body)).toEqual({ stormCode: 'STORM01', cloudId: 7, deviceId: 'device-1', value: 1 });
    expect(wrapper.text()).toContain('Thanks, your vote is in');
    expect(wrapper.text()).toContain('Change my vote');
    expect(localStorage.getItem('votestorm_voted_STORM01_7')).toBe('1');
  });

  it('lets a voter change their vote, with their previous pick highlighted', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    await wrapper.find('button.btn:not(.primary)').trigger('click');
    expect(wrapper.findAll('.choice')[0].classes()).toContain('picked');
  });

  it('requires Submit for multi-select and sends the sorted picks', async () => {
    const wrapper = await mountVote(state({ currentCloud: { ...choice, multi: true } }));
    const submit = wrapper.find('button.btn.primary');
    expect((submit.element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.findAll('.choice')[2].trigger('click');
    await wrapper.findAll('.choice')[0].trigger('click');
    await submit.trigger('click');
    await flushPromises();
    const call = apiMock.mock.calls.find((c) => c[0] === 'vote')!;
    expect(JSON.parse(call[1].body).value).toEqual([0, 2]);
  });

  it('shows only a response counter after voting while results are hidden', async () => {
    const wrapper = await mountVote(state({ currentCloud: { ...choice, resultsHidden: true }, tally: { totalVotes: 3, hidden: true } }));
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('.big-count').text()).toBe('3');
    expect(wrapper.find('.sbar').exists()).toBe(false);
  });

  it('updates results live from tally events and moves on when the cloud changes', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    channel.handlers.tally({ cloudId: 7, counts: [2, 1, 0], totalVotes: 3 });
    await flushPromises();
    expect(wrapper.findAll('.sbar')[0].text()).toContain('2');
    channel.handlers.state({ status: 'active', currentCloud: { ...choice, id: 8, body: 'Next one' }, initialTally: { counts: [0, 0, 0], totalVotes: 0 } });
    await flushPromises();
    expect(wrapper.text()).toContain('Next one');
    expect(wrapper.find('.choice').exists()).toBe(true);
  });

  it('forgets votes when the presenter resets', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    channel.handlers.reset({ cloudId: 7 });
    await flushPromises();
    expect(localStorage.getItem('votestorm_voted_STORM01_7')).toBeNull();
    expect(wrapper.find('.choice').exists()).toBe(true);
  });

  it('shows a friendly message for an unknown storm', async () => {
    apiMock.mockImplementation(async () => {
      const { ApiError } = await import('@/api');
      throw new ApiError('Storm not found', 404);
    });
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/vote/NOPE00');
    await router.isReady();
    const wrapper = mount(VoteView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain("We couldn't find that Storm.");
  });

  it('shows the swipeable results (and no vote buttons) for a closed storm', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('get-storm-state')) return state({ status: 'closed', currentCloud: null, tally: null });
      if (path.startsWith('get-storm-results')) {
        return { clouds: [{ ...choice, correct: [0], tally: { counts: [2, 1, 0], totalVotes: 3 } }] };
      }
      throw new Error('unexpected ' + path);
    });
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/vote/STORM01');
    await router.isReady();
    const wrapper = mount(VoteView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('.carousel').exists()).toBe(true);
    expect(wrapper.text()).toContain('Cloud 1');
    expect(wrapper.text()).not.toContain('closed');
    expect(wrapper.find('.choice').exists()).toBe(false);
  });

  it('shows that it is loading, instead of an empty page, until the storm has loaded', async () => {
    let release: (v: StormState) => void = () => {};
    apiMock.mockImplementation((path: string) => (path.startsWith('get-storm-state') ? new Promise<StormState>((r) => (release = r)) : Promise.resolve({})));
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/vote/STORM01');
    await router.isReady();
    const wrapper = mount(VoteView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('.loading-state').text()).toContain('Loading');
    expect(wrapper.text()).not.toContain('Waiting for the next cloud');
    release(state());
    await flushPromises();
    expect(wrapper.find('.loading-state').exists()).toBe(false);
    expect(wrapper.text()).toContain('Favourite fruit?');
  });

  describe('content and word clouds', () => {
    const content: Cloud = {
      ...choice, id: 20, kind: 'content', options: null, body: '**Read** this\n\n![alt](https://example.com/a.png)',
    };
    const words: Cloud = { ...choice, id: 21, kind: 'words', options: null, body: 'One word for today?', maxWords: 2 };
    const status = (w: { find: (s: string) => { text: () => string } }) => w.find('p[role=status]').text();

    it('shows a content cloud as rendered text and an image, with no vote buttons and a heading to focus', async () => {
      const wrapper = await mountVote(state({ currentCloud: content, tally: { counts: [], totalVotes: 0 } }));
      expect(wrapper.find('.md strong').text()).toBe('Read');
      expect(wrapper.find('.md img').attributes('src')).toBe('https://example.com/a.png');
      expect(wrapper.find('.choice').exists()).toBe(false);
      expect(wrapper.find('.rate').exists()).toBe(false);
      expect(wrapper.find('button.btn.primary').exists()).toBe(false);
      expect(wrapper.findAll('h1')).toHaveLength(1);
      expect(wrapper.find('h1.sr-only').attributes('tabindex')).toBe('-1');
      expect(status(wrapper)).toBe('New cloud');
    });

    it('renders a choice cloud body as markdown above the options', async () => {
      const wrapper = await mountVote(state({ currentCloud: { ...choice, body: '*Which?*' } }));
      expect(wrapper.find('.prompt .md em').text()).toBe('Which?');
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      expect(status(wrapper)).toBe('New cloud: Which?');
    });

    it('announces a new cloud as plain words: hyphens kept, link text not URLs', async () => {
      const wrapper = await mountVote(state({ currentCloud: { ...choice, body: '## A well-known [site](https://example.com)?' } }));
      expect(status(wrapper)).toBe('New cloud: A well-known site?');
    });

    it('shows a sticky timer chip on a content cloud, running and closed', async () => {
      const running = await mountVote(state({ currentCloud: { ...content, votingMsLeft: 90000 }, tally: { counts: [], totalVotes: 0 } }));
      const chip = running.find('[role=timer]');
      expect(chip.text()).toBe('1:30 left');
      expect(chip.classes()).toContain('sticky-timer');
      running.unmount();
      const closed = await mountVote(state({ currentCloud: { ...content, votingMsLeft: 0 }, tally: { counts: [], totalVotes: 0 } }));
      expect(closed.find('[role=timer]').text()).toBe("Time's up");
    });

    it('keeps showing a content cloud whose time is up, with no vote or results wording', async () => {
      const wrapper = await mountVote(state({ currentCloud: { ...content, votingMsLeft: 0 }, tally: { counts: [], totalVotes: 0 } }));
      expect(wrapper.find('.content-card .md strong').text()).toBe('Read');
      expect(wrapper.text()).not.toContain('Live results');
      expect(wrapper.text()).not.toContain('taking votes');
      expect(wrapper.find('.slide-card').exists()).toBe(false);
      expect(wrapper.findAll('h2').map((h) => h.text())).not.toContain("Time's up");
      expect(wrapper.find('[role=timer]').text()).toBe("Time's up");
    });

    it('says Voting closed once for a closed question: in the card heading, with no repeating chip', async () => {
      const wrapper = await mountVote(state({ currentCloud: { ...choice, votingMsLeft: 0 } }));
      expect(wrapper.find('.state h2').text()).toBe('Voting closed');
      expect(wrapper.find('[role=timer]').exists()).toBe(false);
    });

    it('shows the closed state for a words cloud that was already closed on first load, before anything was sent', async () => {
      const wrapper = await mountVote(state({ currentCloud: { ...words, votingMsLeft: 0 }, tally: { words: [{ word: 'team', count: 2 }], totalVotes: 2 } }));
      expect(wrapper.find('.state h2').text()).toBe('Submissions closed');
      expect(wrapper.text()).toContain('This cloud is no longer taking words.');
      expect(wrapper.find('input').exists()).toBe(false);
      expect(wrapper.find('ul.word-cloud').text()).toContain('team');
      expect(wrapper.find('[role=timer]').exists()).toBe(false);
    });

    it('does not scroll or move focus for a state or tally event about the same cloud', async () => {
      const wrapper = await mountVote(state(), document.body);
      const button = wrapper.findAll('.choice')[1].element as HTMLButtonElement;
      button.focus();
      (window.scrollTo as unknown as ReturnType<typeof vi.fn>).mockClear();
      channel.handlers.state({ status: 'active', currentCloud: { ...choice, votingMsLeft: 30000 }, initialTally: { counts: [1, 0, 0], totalVotes: 1 } });
      channel.handlers.tally({ cloudId: 7, counts: [2, 0, 0], totalVotes: 2 });
      await flushPromises();
      expect(window.scrollTo).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
      wrapper.unmount();
    });

    it('takes words, posts them, then shows the cloud and lets the person change them', async () => {
      const wrapper = await mountVote(state({ currentCloud: words, tally: { words: [], totalVotes: 0 } }));
      expect(wrapper.text()).toContain('0 of 2 words');
      const input = wrapper.find('input');
      await input.setValue('Team');
      await input.trigger('keydown', { key: 'Enter' });
      voteReply = { ok: true, tally: { words: [{ word: 'team', count: 1 }], totalVotes: 1 }, words: ['team'] };
      await wrapper.find('button.send-words').trigger('click');
      await flushPromises();
      const call = apiMock.mock.calls.find((c) => c[0] === 'vote')!;
      expect(JSON.parse(call[1].body)).toEqual({ stormCode: 'STORM01', cloudId: 21, deviceId: 'device-1', value: ['team'] });
      expect(wrapper.text()).toContain('Thanks, your words are in');
      expect(wrapper.find('ul.word-cloud').text()).toContain('team');
      expect(JSON.parse(localStorage.getItem('votestorm_vote_STORM01_21')!)).toEqual(['team']);
      await wrapper.findAll('button').find((b) => b.text() === 'Change my words')!.trigger('click');
      expect(wrapper.findAll('.word-chip').map((c) => c.text().replace('\u00d7', '').trim())).toEqual(['team']);
    });

    it('starts the next word cloud empty: unsent words do not carry over', async () => {
      const wrapper = await mountVote(state({ currentCloud: words, tally: { words: [], totalVotes: 0 } }));
      const input = wrapper.find('input');
      await input.setValue('Leftover');
      await input.trigger('keydown', { key: 'Enter' });
      expect(wrapper.findAll('.word-chip')).toHaveLength(1);
      channel.handlers.state({ status: 'active', currentCloud: { ...words, id: 22, body: 'Second words cloud?' }, initialTally: { words: [], totalVotes: 0 } });
      await flushPromises();
      expect(wrapper.text()).toContain('Second words cloud?');
      expect(wrapper.findAll('.word-chip')).toHaveLength(0);
      expect(wrapper.text()).not.toContain('Leftover');
    });

    it('marks a words cloud closed when the server says voting has closed', async () => {
      const wrapper = await mountVote(state({ currentCloud: words, tally: { words: [], totalVotes: 0 } }));
      await wrapper.find('input').setValue('hello');
      apiMock.mockImplementation(async () => {
        throw Object.assign(new Error('closed'), { code: 'voting_closed' });
      });
      await wrapper.find('button.send-words').trigger('click');
      await flushPromises();
      expect(wrapper.find('.state h2').text()).toBe('Submissions closed');
      expect(wrapper.find('input').exists()).toBe(false);
    });

    it('scrolls to the top and focuses the heading when the live cloud changes', async () => {
      const wrapper = await mountVote(state(), document.body);
      (window.scrollTo as unknown as ReturnType<typeof vi.fn>).mockClear();
      channel.handlers.state({ status: 'active', currentCloud: { ...choice, id: 8, body: 'Next' }, initialTally: { counts: [0, 0, 0], totalVotes: 0 } });
      await flushPromises();
      expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(document.activeElement).toBe(wrapper.find('h1.sr-only').element);
      wrapper.unmount();
    });
  });

  describe('vote memory per Storm', () => {
    it('ignores and removes old-shape keys, so a cloud id seen before does not look voted', async () => {
      localStorage.setItem('votestorm_voted_1', '1');
      localStorage.setItem('votestorm_vote_1', '0');
      const router = createRouter({ history: createMemoryHistory(), routes });
      router.push('/vote/ABCDEFGH');
      await router.isReady();
      apiMock.mockImplementation(async () => state({ currentCloud: { ...choice, id: 1 } }));
      const wrapper = mount(VoteView, { global: { plugins: [router] } });
      await flushPromises();
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      expect(wrapper.text()).not.toContain('Thanks, your vote is in');
      expect(localStorage.getItem('votestorm_voted_1')).toBeNull();
      expect(localStorage.getItem('votestorm_vote_1')).toBeNull();
    });

    const mountAt = async (route: string, cloudId: number) => {
      const router = createRouter({ history: createMemoryHistory(), routes });
      router.push(route);
      await router.isReady();
      apiMock.mockImplementation(async (p: string) => (p.startsWith('vote') ? { ok: true } : state({ currentCloud: { ...choice, id: cloudId } })));
      const wrapper = mount(VoteView, { global: { plugins: [router] } });
      await flushPromises();
      return wrapper;
    };

    it('remembers a vote under the same keys whether the link says abcd-efgh or ABCDEFGH', async () => {
      const lower = await mountAt('/vote/abcd-efgh', 4);
      await lower.findAll('.choice')[2].trigger('click');
      await flushPromises();
      lower.unmount();
      const keys = Object.keys(localStorage).sort();
      expect(keys).toEqual(['votestorm_vote_ABCDEFGH_4', 'votestorm_voted_ABCDEFGH_4']);
      const upper = await mountAt('/vote/ABCDEFGH', 4);
      expect(upper.text()).toContain('Thanks, your vote is in');
      expect(Object.keys(localStorage).sort()).toEqual(keys);
    });

    it('does not treat cloud 1 of a new Storm as voted because another Storm\'s cloud 1 was', async () => {
      localStorage.setItem('votestorm_voted_ZZZZZZZZ_1', '1');
      localStorage.setItem('votestorm_vote_ZZZZZZZZ_1', '0');
      const wrapper = await mountAt('/vote/ABCDEFGH', 1);
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      expect(wrapper.find('.choice.picked').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Thanks, your vote is in');
      expect(localStorage.getItem('votestorm_voted_ZZZZZZZZ_1')).toBe('1');
    });

    it('stores a vote under this Storm\'s keys, and a reset removes only those', async () => {
      localStorage.setItem('votestorm_voted_ZZZZZZZZ_1', '1');
      const wrapper = await mountVote(state());
      await wrapper.findAll('.choice')[0].trigger('click');
      await flushPromises();
      expect(localStorage.getItem('votestorm_voted_STORM01_7')).toBe('1');
      expect(localStorage.getItem('votestorm_vote_STORM01_7')).toBe('0');
      channel.handlers.reset({});
      await flushPromises();
      expect(localStorage.getItem('votestorm_voted_STORM01_7')).toBeNull();
      expect(localStorage.getItem('votestorm_vote_STORM01_7')).toBeNull();
      expect(localStorage.getItem('votestorm_voted_ZZZZZZZZ_1')).toBe('1');
    });
  });

  it('keeps the markdown layout rules in the stylesheet (images, long words, wide tables)', () => {
    const css = readFileSync(path.resolve(__dirname, '../../src/assets/styles.css'), 'utf8');
    expect(css).toMatch(/\.md img\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.md\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.md table\s*\{[^}]*overflow-x:\s*auto/);
  });
});
