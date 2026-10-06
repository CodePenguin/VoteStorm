// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { describeActivity } from '@/lib/activity';
import {
  DONE_MS, ERROR_MS, MIN_WORKING_MS, SHOW_DELAY_MS, activity, beginActivity, dismissActivity, resetActivity,
} from '@/composables/useActivity';
import ActivityToast from '@/components/ActivityToast.vue';
import { api } from '@/api';

describe('describeActivity', () => {
  const patch = (path: string, body: object) => describeActivity(path, 'PATCH', JSON.stringify(body));

  it('says what is happening for each kind of user action', () => {
    expect(describeActivity('vote', 'POST', '{}')).toEqual({ working: 'Submitting your vote…', done: 'Vote submitted' });
    expect(describeActivity('create-storm', 'POST')?.done).toBe('Storm created');
    expect(describeActivity('admin-questions', 'POST', '{}')?.done).toBe('Question added');
    expect(describeActivity('admin-questions', 'DELETE', '{}')?.done).toBe('Question deleted');
    expect(patch('admin-questions', { edit: {} })?.done).toBe('Question saved');
    expect(patch('admin-questions', { action: 'reset' })?.done).toBe('Votes reset');
    expect(patch('admin-questions', { orderIndex: 2 })?.done).toBe('Order saved');
    expect(patch('admin-storm', { showConnect: true })?.done).toBe('Join screen updated');
    expect(patch('admin-storm', { resultsHidden: true })?.done).toBe('Results updated');
    expect(patch('admin-storm', { answerShown: true })?.done).toBe('Results updated');
    expect(patch('admin-storm', { status: 'active', currentQuestionId: 4 })?.done).toBe('Question changed');
    expect(patch('admin-storm', { status: 'closed' })?.done).toBe('Storm ended');
    expect(patch('admin-storm', { status: 'lobby' })?.done).toBe('Storm updated');
    expect(patch('admin-storm', { action: 'reset' })?.done).toBe('Votes reset');
    expect(describeActivity('admin-storm', 'DELETE', '{}')?.done).toBe('Storm deleted');
  });

  it('stays quiet for reads and for things the page does by itself', () => {
    expect(describeActivity('get-storm-state?stormCode=X', 'GET')).toBeNull();
    expect(describeActivity('admin-storm?adminKey=k', 'GET')).toBeNull();
    expect(describeActivity('results-activate', 'POST', '{}')).toBeNull();
    expect(describeActivity('ably-token?stormCode=X', 'GET')).toBeNull();
  });

  it('falls back to a generic message for an unknown change', () => {
    expect(describeActivity('something-new', 'POST')).toEqual({ working: 'Saving…', done: 'Saved' });
    expect(describeActivity('admin-storm', 'PATCH', 'not json')).toEqual({ working: 'Saving…', done: 'Saved' });
  });
});

describe('activity notice', () => {
  const labels = { working: 'Saving…', done: 'Saved' };

  beforeEach(() => {
    vi.useFakeTimers();
    resetActivity();
  });
  afterEach(() => {
    resetActivity();
    vi.useRealTimers();
  });

  it('confirms a quick request without flashing a spinner', () => {
    const finish = beginActivity(labels);
    vi.advanceTimersByTime(50);
    expect(activity.value).toBeNull();
    finish({ ok: true });
    vi.advanceTimersByTime(0);
    expect(activity.value).toEqual({ kind: 'done', message: 'Saved' });
    vi.advanceTimersByTime(DONE_MS + 1);
    expect(activity.value).toBeNull();
  });

  it('shows what is happening once a request is slow, then keeps it up long enough to read', () => {
    const finish = beginActivity(labels);
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    expect(activity.value).toEqual({ kind: 'working', message: 'Saving…' });
    vi.advanceTimersByTime(100);
    finish({ ok: true });
    vi.advanceTimersByTime(MIN_WORKING_MS - 200);
    expect(activity.value?.kind).toBe('working');
    vi.advanceTimersByTime(200);
    expect(activity.value).toEqual({ kind: 'done', message: 'Saved' });
  });

  it('shows one notice for a multi-step action and confirms when the last step lands', () => {
    const first = beginActivity({ working: 'Saving order…', done: 'Order saved' });
    const second = beginActivity({ working: 'Saving order…', done: 'Order saved' });
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    expect(activity.value?.kind).toBe('working');
    first({ ok: true });
    vi.advanceTimersByTime(MIN_WORKING_MS + 1);
    expect(activity.value?.kind).toBe('working');
    second({ ok: true });
    vi.advanceTimersByTime(MIN_WORKING_MS + 1);
    expect(activity.value).toEqual({ kind: 'done', message: 'Order saved' });
  });

  it('shows a failure straight away, keeps it longer, and does not let a later success cover it', () => {
    const failing = beginActivity(labels);
    const other = beginActivity(labels);
    failing({ ok: false, message: 'This storm has reached its audience limit.' });
    expect(activity.value).toEqual({ kind: 'error', message: 'This storm has reached its audience limit.' });
    other({ ok: true });
    vi.advanceTimersByTime(DONE_MS + 100);
    expect(activity.value?.kind).toBe('error');
    vi.advanceTimersByTime(ERROR_MS);
    expect(activity.value).toBeNull();
  });

  it('lets the user dismiss an error', () => {
    beginActivity(labels)({ ok: false, message: 'Nope' });
    dismissActivity();
    expect(activity.value).toBeNull();
  });

  it('ignores a request being reported twice', () => {
    const finish = beginActivity(labels);
    finish({ ok: true });
    finish({ ok: false, message: 'late' });
    vi.advanceTimersByTime(0);
    expect(activity.value).toEqual({ kind: 'done', message: 'Saved' });
  });
});

describe('api() reports user-triggered requests', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    resetActivity();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    resetActivity();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  it('confirms a vote, and strips the notice option before calling fetch', async () => {
    fetchMock.mockResolvedValue(ok());
    await api('vote', { method: 'POST', body: JSON.stringify({ value: 1 }) });
    vi.advanceTimersByTime(0);
    expect(activity.value).toEqual({ kind: 'done', message: 'Vote submitted' });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('activity');
  });

  it('shows the working notice while a slow save is in flight', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r)));
    const pending = api('admin-storm', { method: 'PATCH', body: JSON.stringify({ showConnect: true }) });
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    expect(activity.value).toEqual({ kind: 'working', message: 'Updating join screen…' });
    release(ok());
    await pending;
    vi.advanceTimersByTime(MIN_WORKING_MS + 1);
    expect(activity.value).toEqual({ kind: 'done', message: 'Join screen updated' });
  });

  it('shows the server message when a save fails, and still throws to the caller', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'This storm has reached its limit of 2 questions.' }), { status: 403 }));
    await expect(api('admin-questions', { method: 'POST', body: '{}' })).rejects.toThrow('limit of 2 questions');
    expect(activity.value).toEqual({ kind: 'error', message: 'This storm has reached its limit of 2 questions.' });
  });

  it('shows a network failure too', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('vote', { method: 'POST', body: '{}' })).rejects.toThrow('Failed to fetch');
    expect(activity.value).toEqual({ kind: 'error', message: 'Failed to fetch' });
  });

  it('says nothing for reads and background calls', async () => {
    fetchMock.mockImplementation(async () => ok());
    await api('get-storm-state?stormCode=X');
    await api('admin-storm?adminKey=k');
    await api('results-activate', { method: 'POST', body: '{}' });
    vi.advanceTimersByTime(SHOW_DELAY_MS + 10);
    expect(activity.value).toBeNull();
  });

  it('can be given its own notice, or silenced', async () => {
    fetchMock.mockImplementation(async () => ok());
    await api('license-status', { activity: { working: 'Checking license…', done: 'License activated' } });
    vi.advanceTimersByTime(0);
    expect(activity.value).toEqual({ kind: 'done', message: 'License activated' });
    resetActivity();
    await api('vote', { method: 'POST', body: '{}', activity: false });
    vi.advanceTimersByTime(SHOW_DELAY_MS + 10);
    expect(activity.value).toBeNull();
  });
});

describe('ActivityToast', () => {
  beforeEach(() => resetActivity());
  afterEach(() => resetActivity());

  it('is an unobtrusive live region that is empty when nothing is happening', () => {
    const wrapper = mount(ActivityToast);
    expect(wrapper.find('[role="status"]').attributes('aria-live')).toBe('polite');
    expect(wrapper.find('.activity-toast').exists()).toBe(false);
  });

  it('shows a spinner while working, a tick when done, and a dismissible message on error', async () => {
    const wrapper = mount(ActivityToast);
    activity.value = { kind: 'working', message: 'Submitting your vote…' };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.spinner').exists()).toBe(true);
    expect(wrapper.text()).toContain('Submitting your vote');
    expect(wrapper.find('.activity-close').exists()).toBe(false);

    activity.value = { kind: 'done', message: 'Vote submitted' };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.spinner').exists()).toBe(false);
    expect(wrapper.find('.activity-toast.done').text()).toBe('Vote submitted');

    activity.value = { kind: 'error', message: 'Not saved' };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.activity-toast.error').text()).toContain('Not saved');
    await wrapper.find('.activity-close').trigger('click');
    expect(wrapper.find('.activity-toast').exists()).toBe(false);
  });
});
