import { computed, onBeforeUnmount, ref, watch } from 'vue';

export type VotingPhase = 'open' | 'running' | 'closed';

/** m:ss, rounding up so the clock never shows 0:00 while time is still left. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The state of a cloud's lock or timer on this screen. The server sends how many milliseconds are left (null while
 * open, 0 once closed), so the deadline is set from this device's own clock and nobody's clock has to agree.
 */
export function useVotingClock(msLeft: () => number | null | undefined) {
  const deadline = ref<number | null>(null);
  const now = ref(Date.now());
  let ticker: ReturnType<typeof setInterval> | null = null;

  function stop() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function tick() {
    now.value = Date.now();
    if (deadline.value !== null && now.value >= deadline.value) stop();
  }

  // The getter returns a fresh object each time, so every new message from the server restarts the clock.
  watch(
    () => ({ ms: msLeft() }),
    ({ ms }) => {
      stop();
      now.value = Date.now();
      deadline.value = ms === null || ms === undefined ? null : now.value + ms;
      if (deadline.value !== null && ms! > 0) ticker = setInterval(tick, 250);
    },
    { immediate: true },
  );
  onBeforeUnmount(stop);

  const remainingMs = computed(() => (deadline.value === null ? null : Math.max(0, deadline.value - now.value)));
  const phase = computed<VotingPhase>(() => (remainingMs.value === null ? 'open' : remainingMs.value === 0 ? 'closed' : 'running'));
  const label = computed(() => (remainingMs.value === null ? '' : formatClock(remainingMs.value)));

  /** The server refused a vote because voting had closed: believe it, whatever this clock says. */
  function markClosed() {
    stop();
    now.value = Date.now();
    deadline.value = now.value;
  }

  return { phase, remainingMs, label, markClosed };
}
