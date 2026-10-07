// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { formatClock, useVotingClock } from '@/composables/useVotingClock';

function harness(initial: number | null | undefined) {
  const ms = ref<{ v: number | null | undefined }>({ v: initial });
  let clock!: ReturnType<typeof useVotingClock>;
  const wrapper = mount(
    defineComponent({
      setup() {
        clock = useVotingClock(() => ms.value.v);
        return () => null;
      },
    }),
  );
  return { clock, wrapper, send: (v: number | null | undefined) => (ms.value = { v }) };
}

describe('formatClock', () => {
  it('shows minutes and seconds, rounding up', () => {
    expect(formatClock(30000)).toBe('0:30');
    expect(formatClock(29001)).toBe('0:30');
    expect(formatClock(61000)).toBe('1:01');
    expect(formatClock(300000)).toBe('5:00');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('useVotingClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('is open when the server sends no timer', () => {
    const { clock } = harness(null);
    expect(clock.phase.value).toBe('open');
    expect(clock.label.value).toBe('');
    expect(harness(undefined).clock.phase.value).toBe('open');
  });

  it('counts down on its own clock and closes when time is up', async () => {
    const { clock } = harness(5000);
    expect(clock.phase.value).toBe('running');
    expect(clock.label.value).toBe('0:05');
    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(clock.label.value).toBe('0:02');
    vi.advanceTimersByTime(2500);
    await nextTick();
    expect(clock.phase.value).toBe('closed');
    expect(clock.label.value).toBe('0:00');
  });

  it('is closed straight away when the server says 0, and reopens on null', async () => {
    const { clock, send } = harness(0);
    expect(clock.phase.value).toBe('closed');
    send(null);
    await nextTick();
    expect(clock.phase.value).toBe('open');
  });

  it('restarts from each new message, even with the same number', async () => {
    const { clock, send } = harness(10000);
    vi.advanceTimersByTime(6000);
    await nextTick();
    expect(clock.label.value).toBe('0:04');
    send(10000);
    await nextTick();
    expect(clock.label.value).toBe('0:10');
    send(45000);
    await nextTick();
    expect(clock.label.value).toBe('0:45');
  });

  it('believes the server when it refuses a vote as closed', async () => {
    const { clock } = harness(60000);
    clock.markClosed();
    await nextTick();
    expect(clock.phase.value).toBe('closed');
  });

  it('stops its timer when the screen goes away', () => {
    const { wrapper } = harness(60000);
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
