import { ref } from 'vue';
import type { ActivityLabels } from '@/lib/activity';

export type ActivityNotice = { kind: 'working' | 'done' | 'error'; message: string } | null;

/** The notice currently on screen. Shared by every request, shown once by the app shell. */
export const activity = ref<ActivityNotice>(null);

// Quick requests skip the spinner and go straight to the confirmation; slow ones show it once it has been
// waiting a moment, and keep it up long enough to read.
export const SHOW_DELAY_MS = 250;
export const MIN_WORKING_MS = 600;
export const DONE_MS = 1800;
export const ERROR_MS = 6000;

let inFlight = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let shownAt = 0;

function clear(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) clearTimeout(timer);
}

function show(notice: Exclude<ActivityNotice, null>, ms: number) {
  clear(hideTimer);
  activity.value = notice;
  hideTimer = setTimeout(() => {
    activity.value = null;
  }, ms);
}

/** Call when a request starts. The returned function reports how it ended. */
export function beginActivity(labels: ActivityLabels): (result: { ok: true } | { ok: false; message: string }) => void {
  inFlight++;
  clear(hideTimer);
  if (activity.value?.kind !== 'error' && !showTimer && activity.value?.kind !== 'working') {
    showTimer = setTimeout(() => {
      showTimer = null;
      if (inFlight > 0 && activity.value?.kind !== 'error') {
        activity.value = { kind: 'working', message: labels.working };
        shownAt = Date.now();
      }
    }, SHOW_DELAY_MS);
  }

  let settled = false;
  return (result) => {
    if (settled) return;
    settled = true;
    inFlight = Math.max(0, inFlight - 1);

    if (!result.ok) {
      clear(showTimer);
      showTimer = null;
      show({ kind: 'error', message: result.message }, ERROR_MS);
      return;
    }
    if (inFlight > 0) return; // wait for the rest of a multi-step action
    clear(showTimer);
    showTimer = null;
    if (activity.value?.kind === 'error') return; // an unread failure outranks a success
    const wait = activity.value?.kind === 'working' ? Math.max(0, MIN_WORKING_MS - (Date.now() - shownAt)) : 0;
    clear(hideTimer);
    hideTimer = setTimeout(() => show({ kind: 'done', message: labels.done }, DONE_MS), wait);
  };
}

export function dismissActivity() {
  clear(hideTimer);
  activity.value = null;
}

/** For tests: forget everything. */
export function resetActivity() {
  clear(showTimer);
  clear(hideTimer);
  showTimer = null;
  hideTimer = null;
  inFlight = 0;
  activity.value = null;
}
