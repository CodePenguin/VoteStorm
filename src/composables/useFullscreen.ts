import { onBeforeUnmount, onMounted, ref } from 'vue';

/** Browser full screen, best effort: the Present layout already fills the window, so a refusal is not an error. */
export function useFullscreen() {
  const supported = typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function';
  const active = ref(false);
  const sync = () => (active.value = !!document.fullscreenElement);

  async function toggle() {
    if (!supported) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* the browser said no (or it was already changing): nothing to do */
    }
  }

  async function exit() {
    if (!supported || !document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      /* already leaving */
    }
  }

  onMounted(() => {
    // Already in full screen when mounted (Exit, then Back to presenting): the button must say so.
    if (supported) sync();
    document.addEventListener('fullscreenchange', sync);
  });
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', sync));
  return { active, supported, toggle, exit };
}
