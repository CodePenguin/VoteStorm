import { onBeforeUnmount, onMounted } from 'vue';

export interface PresentKeyHandlers {
  prev(): void;
  next(): void;
  arm(): void;
  startTimer(seconds: number): void;
  toggleResults(): void;
  toggleJoin(): void;
  edit(): void;
  fullscreen(): void;
  dock(): void;
  escape(): void;
}

/** 15s, 30s, 1m, 2m, 5m: the keys 1 to 5 once the timer is armed. */
export const TIMER_KEYS = [15, 30, 60, 120, 300];

/** True for anything the presenter could be typing into, where shortcut letters must never fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/** Runs the shortcut for a key. Returns whether it was handled (and then the browser's own action is cancelled). */
export function handlePresentKey(e: KeyboardEvent, h: PresentKeyHandlers, state: { overlayOpen: boolean; armed: boolean }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  // An input method composing text, or a handler that already dealt with the key, owns it.
  if (e.isComposing || e.defaultPrevented) return false;
  // A held key (or a clicker that auto-repeats) acts once per press: no skipping clouds, no flickering toggles on the projector.
  if (e.repeat) return false;
  const typing = isTypingTarget(e.target);
  let run: (() => void) | null = null;

  if (state.overlayOpen) {
    // Over the edit overlay only Escape acts, and not while a field has focus (it could discard what is being typed).
    if (e.key === 'Escape' && !typing) run = h.escape;
  } else if (!typing) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowLeft') run = h.prev;
    else if (k === 'ArrowRight') run = h.next;
    else if (k === 't') run = h.arm;
    else if (k === 'h') run = h.toggleResults;
    else if (k === 'j') run = h.toggleJoin;
    else if (k === 'e') run = h.edit;
    else if (k === 'f') run = h.fullscreen;
    else if (k === 'd') run = h.dock;
    else if (k === 'Escape') run = h.escape;
    else if (state.armed && /^[1-5]$/.test(k)) {
      const seconds = TIMER_KEYS[Number(k) - 1];
      run = () => h.startTimer(seconds);
    }
  }
  if (!run) return false;
  e.preventDefault();
  run();
  return true;
}

/** Listens for the Present shortcuts on the window while `active()` is true. */
export function usePresentKeys(handlers: PresentKeyHandlers, state: () => { overlayOpen: boolean; armed: boolean }, active: () => boolean) {
  const onKey = (e: KeyboardEvent) => {
    if (active()) handlePresentKey(e, handlers, state());
  };
  onMounted(() => window.addEventListener('keydown', onKey));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
}
