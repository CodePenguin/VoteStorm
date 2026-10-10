// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useFitText } from '@/composables/useFitText';

// jsdom has no layout, so the heights are supplied: the inner content is `contentHeight * scale` tall in a box of `boxHeight`.
function setup(contentHeight: number, boxHeight: number, min?: number) {
  const trigger = ref(0);
  let fit!: () => void;
  const Comp = defineComponent({
    setup() {
      const box = ref<HTMLElement | null>(null);
      const inner = ref<HTMLElement | null>(null);
      ({ fit } = useFitText(box, inner, () => trigger.value, { min }));
      return () => h('div', { ref: box }, [h('div', { ref: inner })]);
    },
  });
  const wrapper = mount(Comp);
  const box = wrapper.element as HTMLElement;
  const inner = box.firstElementChild as HTMLElement;
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => boxHeight });
  Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => contentHeight * parseFloat(inner.style.getPropertyValue('--fit') || '1') });
  return { fit, inner, trigger };
}

describe('useFitText', () => {
  it('leaves content that already fits at full size', () => {
    const { fit, inner } = setup(300, 600);
    fit();
    expect(parseFloat(inner.style.getPropertyValue('--fit'))).toBe(1);
  });
  it('shrinks content that is too tall until it fits', () => {
    const { fit, inner } = setup(1000, 600);
    fit();
    const scale = parseFloat(inner.style.getPropertyValue('--fit'));
    expect(scale).toBeLessThan(1);
    expect(1000 * scale).toBeLessThanOrEqual(600);
  });
  it('stops at the minimum rather than shrinking forever', () => {
    const { fit, inner } = setup(100000, 600, 0.5);
    fit();
    expect(parseFloat(inner.style.getPropertyValue('--fit'))).toBeGreaterThanOrEqual(0.5);
  });
  it('fits again when the watched content changes', async () => {
    const { inner, trigger } = setup(1000, 600);
    trigger.value++;
    await nextTick();
    await nextTick();
    expect(parseFloat(inner.style.getPropertyValue('--fit'))).toBeLessThan(1);
  });
  it('never loops forever on a tiny or zero minimum', () => {
    const { fit, inner } = setup(100000, 600, 0);
    fit();
    expect(parseFloat(inner.style.getPropertyValue('--fit'))).toBeGreaterThanOrEqual(0.1);
  });

  describe('ResizeObserver', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('observes an inner element that appears after mount, and moves to a replacement', async () => {
      const observed: Element[] = [];
      const disconnect = vi.fn();
      vi.stubGlobal('ResizeObserver', class { constructor(public cb: () => void) {} observe(el: Element) { observed.push(el); } disconnect() { disconnect(); } });
      const show = ref(false);
      const key = ref(0);
      const Comp = defineComponent({
        setup() {
          const box = ref<HTMLElement | null>(null);
          const inner = ref<HTMLElement | null>(null);
          useFitText(box, inner, () => 0);
          return () => h('div', { ref: box }, show.value ? [h('div', { ref: inner, key: key.value })] : []);
        },
      });
      mount(Comp);
      expect(observed).toHaveLength(0);
      show.value = true;
      await nextTick();
      await nextTick();
      expect(observed).toHaveLength(1);
      key.value++;
      await nextTick();
      await nextTick();
      expect(observed).toHaveLength(2);
      expect(observed[1]).not.toBe(observed[0]);
      expect(disconnect).toHaveBeenCalled();
    });

    it('is safe when ResizeObserver does not exist', async () => {
      vi.stubGlobal('ResizeObserver', undefined);
      const { fit } = setup(100, 600);
      expect(() => fit()).not.toThrow();
    });
  });
});
