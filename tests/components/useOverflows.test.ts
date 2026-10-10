// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useOverflows } from '@/composables/useOverflows';

// jsdom has no layout: scrollHeight and clientHeight are stubbed, and ResizeObserver is a fake the test can fire.
const observers: { cb: () => void; targets: Element[] }[] = [];
class FakeResizeObserver {
  targets: Element[] = [];
  constructor(public cb: () => void) {
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {
    this.targets = [];
  }
}

function sized(el: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scroll });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
}

const Probe = defineComponent({
  setup() {
    const box = ref<HTMLElement | null>(null);
    const overflows = useOverflows(box);
    return () => h('div', { ref: box, class: { box: true, overflowing: overflows.value } }, [h('p', 'text')]);
  },
});

describe('useOverflows', () => {
  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  it('reports overflow only when the content is taller than the box, and follows size changes', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const wrapper = mount(Probe);
    await wrapper.vm.$nextTick();
    const box = wrapper.find('.box').element as HTMLElement;
    expect(wrapper.classes()).not.toContain('overflowing');
    // Both the box and its content are watched, so a body that renders taller later is noticed.
    expect(observers[0].targets).toEqual([box, box.firstElementChild]);
    sized(box, 300, 120);
    observers[0].cb();
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('overflowing');
    sized(box, 120, 120);
    observers[0].cb();
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).not.toContain('overflowing');
  });

  it('works without ResizeObserver (no fade, no error)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const wrapper = mount(Probe);
    expect(wrapper.classes()).not.toContain('overflowing');
  });
});
