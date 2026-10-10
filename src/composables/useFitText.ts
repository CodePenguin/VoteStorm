import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';

/**
 * Shrinks `inner` (by setting its --fit scale, 1 down to `min`) until it fits the height of `box`. Used on the projector so
 * a long cloud is readable without scrolling; below `min` the box scrolls instead.
 */
export function useFitText(box: Ref<HTMLElement | null>, inner: Ref<HTMLElement | null>, source: () => unknown, options: { min?: number | (() => number) } = {}) {
  let observer: ResizeObserver | null = null;

  function fit() {
    const b = box.value;
    const i = inner.value;
    if (!b || !i) return;
    // Never below 0.1, so a tiny or zero minimum cannot make the shrink loop run (nearly) forever.
    const wanted = typeof options.min === 'function' ? options.min() : options.min;
    const min = Math.max(0.1, wanted ?? 0.45);
    let scale = 1;
    i.style.setProperty('--fit', String(scale));
    while (i.scrollHeight > b.clientHeight && scale > min) {
      scale = Math.max(min, Math.round(scale * 0.92 * 1000) / 1000);
      i.style.setProperty('--fit', String(scale));
    }
  }

  watch(source, () => nextTick(fit), { flush: 'post' });
  onMounted(() => {
    fit();
    window.addEventListener('resize', fit);
  });
  // The inner element can appear after mount (the page renders it once its data has loaded), and be replaced later.
  watch(
    inner,
    (el) => {
      observer?.disconnect();
      observer = null;
      if (el && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => fit());
        observer.observe(el);
      }
    },
    { flush: 'post', immediate: true },
  );
  onBeforeUnmount(() => {
    window.removeEventListener('resize', fit);
    observer?.disconnect();
  });

  return { fit };
}
