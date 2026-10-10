import { onBeforeUnmount, onMounted, ref } from 'vue';

const RAIL = '(min-width: 720px)';
const TITLE = '(min-width: 1024px) and (min-height: 700px)';

/** Which Present layout fits the window: a right-hand rail or a bottom bar, and whether there is room for the title. */
export function usePresentLayout() {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  // Without matchMedia (very old browsers, tests) assume a normal desktop window without the title.
  const rail = ref(true);
  const showTitle = ref(false);
  const cleanups: (() => void)[] = [];

  function track(query: string, target: typeof rail) {
    const list = window.matchMedia(query);
    target.value = list.matches;
    const onChange = (e: { matches: boolean }) => (target.value = e.matches);
    list.addEventListener('change', onChange);
    cleanups.push(() => list.removeEventListener('change', onChange));
  }

  onMounted(() => {
    if (!supported) return;
    track(RAIL, rail);
    track(TITLE, showTitle);
  });
  onBeforeUnmount(() => cleanups.forEach((fn) => fn()));
  return { rail, showTitle };
}
