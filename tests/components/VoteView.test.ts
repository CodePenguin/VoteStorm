// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import type { Question, StormState } from '@/shared/types';

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

const channel = { handlers: {} as Record<string, (d: any) => void>, close: vi.fn() };
vi.mock('@/composables/useStormChannel', () => ({
  subscribeStorm: (_code: string, handlers: Record<string, (d: any) => void>) => {
    channel.handlers = handlers;
    return { close: channel.close };
  },
}));

import VoteView from '@/views/VoteView.vue';

const choice: Question = {
  id: 7, type: 'choice', prompt: 'Favourite fruit?', options: ['Apple', 'Banana', 'Cherry'], scaleMin: null, scaleMax: null,
  multi: false, display: 'bars', resultsHidden: false, correct: null,
};

function state(overrides: Partial<StormState> = {}): StormState {
  return { status: 'active', currentQuestion: choice, tally: { counts: [0, 0, 0], totalVotes: 0 }, showConnect: false, ...overrides };
}

async function mountVote(stormState: StormState) {
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith('get-storm-state')) return stormState;
    if (path.startsWith('vote')) return { ok: true };
    throw new Error('unexpected ' + path);
  });
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push('/vote/STORM01');
  await router.isReady();
  const wrapper = mount(VoteView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('VoteView', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
  });

  it('waits when no question is live', async () => {
    const wrapper = await mountVote(state({ currentQuestion: null, tally: null }));
    expect(wrapper.text()).toContain('Waiting for the next question');
  });

  describe('locked and timed voting', () => {
    const timed = (ms: number | null) => state({ currentQuestion: { ...choice, votingMsLeft: ms } });

    it('shows the time left while voting is open, and still takes votes', async () => {
      const wrapper = await mountVote(timed(45000));
      expect(wrapper.find('.voting-clock').text()).toBe('0:45 left');
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      wrapper.unmount();
    });

    it('does not show a clock for a question with no timer', async () => {
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
      localStorage.setItem('votestorm_voted_7', '1');
      const wrapper = await mountVote(timed(0));
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.text()).toContain('Your vote is in.');
      expect(wrapper.text()).not.toContain('Change my vote');
    });

    it('closes the question live when the presenter locks it', async () => {
      const wrapper = await mountVote(timed(null));
      expect(wrapper.findAll('.choice')).toHaveLength(3);
      channel.handlers.state({ status: 'active', currentQuestion: { ...choice, votingMsLeft: 0 }, initialTally: { counts: [0, 0, 0], totalVotes: 0 }, showConnect: false });
      await flushPromises();
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.findAll('.choice')).toHaveLength(0);
    });

    it('believes the server when it refuses a vote because voting has closed', async () => {
      const wrapper = await mountVote(timed(60000));
      apiMock.mockImplementation(async () => {
        throw Object.assign(new Error('Voting has closed for this question.'), { code: 'voting_closed' });
      });
      await wrapper.findAll('.choice')[0].trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Voting closed');
      expect(wrapper.findAll('.choice')).toHaveLength(0);
      wrapper.unmount();
    });
  });

  it('shows a single-choice question and submits a vote with the device id', async () => {
    const wrapper = await mountVote(state());
    expect(wrapper.text()).toContain('Favourite fruit?');
    await wrapper.findAll('.choice')[1].trigger('click');
    await flushPromises();
    const call = apiMock.mock.calls.find((c) => c[0] === 'vote')!;
    expect(JSON.parse(call[1].body)).toEqual({ stormCode: 'STORM01', questionId: 7, deviceId: 'device-1', value: 1 });
    expect(wrapper.text()).toContain('Thanks, your vote is in');
    expect(wrapper.text()).toContain('Change my vote');
    expect(localStorage.getItem('votestorm_voted_7')).toBe('1');
  });

  it('lets a voter change their vote, with their previous pick highlighted', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    await wrapper.find('button.btn:not(.primary)').trigger('click');
    expect(wrapper.findAll('.choice')[0].classes()).toContain('picked');
  });

  it('requires Submit for multi-select and sends the sorted picks', async () => {
    const wrapper = await mountVote(state({ currentQuestion: { ...choice, multi: true } }));
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
    const wrapper = await mountVote(state({ currentQuestion: { ...choice, resultsHidden: true }, tally: { totalVotes: 3, hidden: true } }));
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('.big-count').text()).toBe('3');
    expect(wrapper.find('.sbar').exists()).toBe(false);
  });

  it('updates results live from tally events and moves on when the question changes', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    channel.handlers.tally({ questionId: 7, counts: [2, 1, 0], totalVotes: 3 });
    await flushPromises();
    expect(wrapper.findAll('.sbar')[0].text()).toContain('2');
    channel.handlers.state({ status: 'active', currentQuestion: { ...choice, id: 8, prompt: 'Next one' }, initialTally: { counts: [0, 0, 0], totalVotes: 0 } });
    await flushPromises();
    expect(wrapper.text()).toContain('Next one');
    expect(wrapper.find('.choice').exists()).toBe(true);
  });

  it('forgets votes when the presenter resets', async () => {
    const wrapper = await mountVote(state());
    await wrapper.findAll('.choice')[0].trigger('click');
    await flushPromises();
    channel.handlers.reset({ questionId: 7 });
    await flushPromises();
    expect(localStorage.getItem('votestorm_voted_7')).toBeNull();
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
      if (path.startsWith('get-storm-state')) return state({ status: 'closed', currentQuestion: null, tally: null });
      if (path.startsWith('get-storm-results')) {
        return { questions: [{ ...choice, correct: [0], tally: { counts: [2, 1, 0], totalVotes: 3 } }] };
      }
      throw new Error('unexpected ' + path);
    });
    const router = createRouter({ history: createMemoryHistory(), routes });
    router.push('/vote/STORM01');
    await router.isReady();
    const wrapper = mount(VoteView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('.carousel').exists()).toBe(true);
    expect(wrapper.text()).toContain('Question 1');
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
    expect(wrapper.text()).not.toContain('Waiting for the next question');
    release(state());
    await flushPromises();
    expect(wrapper.find('.loading-state').exists()).toBe(false);
    expect(wrapper.text()).toContain('Favourite fruit?');
  });
});
