import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * True while `el`'s content is taller than `el` (a clamped box), so a fade can show that there is more. Watches the box and
 * its children, because the content (a markdown body, a word cloud) can grow after the box is mounted.
 */
export function useOverflows(el: Ref<HTMLElement | null>): Ref<boolean> {
  const overflows = ref(false);
  let observer: ResizeObserver | null = null;

  const check = () => {
    const box = el.value;
    overflows.value = !!box && box.scrollHeight > box.clientHeight + 1;
  };

  watch(
    el,
    (box) => {
      observer?.disconnect();
      observer = null;
      if (box && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(check);
        observer.observe(box);
        for (const child of Array.from(box.children)) observer.observe(child);
      }
      check();
    },
    { immediate: true, flush: 'post' },
  );
  onBeforeUnmount(() => observer?.disconnect());
  return overflows;
}
