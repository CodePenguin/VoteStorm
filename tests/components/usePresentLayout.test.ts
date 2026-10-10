// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { usePresentLayout } from '@/composables/usePresentLayout';

type Listener = (e: { matches: boolean }) => void;
function stubMatchMedia(state: { width: number; height: number }) {
  const lists: { query: string; listeners: Set<Listener>; matches: () => boolean }[] = [];
  const test = (query: string) => {
    const min = (name: string) => Number(new RegExp(`min-${name}:\\s*(\\d+)px`).exec(query)?.[1] ?? 0);
    return state.width >= min('width') && state.height >= min('height');
  };
  window.matchMedia = vi.fn((query: string) => {
    const entry = { query, listeners: new Set<Listener>(), matches: () => test(query) };
    lists.push(entry);
    return {
      get matches() { return entry.matches(); }, media: query,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
    } as unknown as MediaQueryList;
  });
  return {
    lists,
    resize(width: number, height: number) { state.width = width; state.height = height; lists.forEach((l) => l.listeners.forEach((fn) => fn({ matches: l.matches() }))); },
  };
}
let lastWrapper: ReturnType<typeof mount> | null = null;
const setup = () => {
  let layout!: ReturnType<typeof usePresentLayout>;
  lastWrapper = mount(defineComponent({ setup() { layout = usePresentLayout(); return () => h('div'); } }));
  return layout;
};

describe('usePresentLayout', () => {
  afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia; });
  it('shows the rail and the title on a large window', () => {
    stubMatchMedia({ width: 1440, height: 900 });
    const layout = setup();
    expect(layout.rail.value).toBe(true);
    expect(layout.showTitle.value).toBe(true);
  });
  it('keeps the rail but drops the title on a window that is wide but short, or narrow', () => {
    stubMatchMedia({ width: 1280, height: 600 });
    expect(setup().showTitle.value).toBe(false);
    stubMatchMedia({ width: 900, height: 900 });
    const layout = setup();
    expect(layout.rail.value).toBe(true);
    expect(layout.showTitle.value).toBe(false);
  });
  it('uses the bottom bar (no rail) on a phone', () => {
    stubMatchMedia({ width: 390, height: 844 });
    const layout = setup();
    expect(layout.rail.value).toBe(false);
    expect(layout.showTitle.value).toBe(false);
  });
  it('follows a resize without a reload', () => {
    const media = stubMatchMedia({ width: 1440, height: 900 });
    const layout = setup();
    media.resize(390, 844);
    expect(layout.rail.value).toBe(false);
    expect(layout.showTitle.value).toBe(false);
    media.resize(1440, 900);
    expect(layout.rail.value).toBe(true);
    expect(layout.showTitle.value).toBe(true);
  });
  it.each([
    [1024, 700, true],
    [1024, 699, false],
    [1023, 700, false],
  ])('at exactly %ix%i the title shows: %s', (width, height, title) => {
    stubMatchMedia({ width, height });
    const layout = setup();
    expect(layout.rail.value).toBe(true);
    expect(layout.showTitle.value).toBe(title);
  });
  it('puts the rail at 720px wide and the bar below it', () => {
    stubMatchMedia({ width: 720, height: 500 });
    expect(setup().rail.value).toBe(true);
    stubMatchMedia({ width: 719, height: 500 });
    expect(setup().rail.value).toBe(false);
  });
  it('stops listening to the window on unmount', () => {
    const media = stubMatchMedia({ width: 1440, height: 900 });
    const layout = setup();
    expect(media.lists.every((l) => l.listeners.size === 1)).toBe(true);
    lastWrapper!.unmount();
    expect(media.lists.every((l) => l.listeners.size === 0)).toBe(true);
    media.resize(390, 844);
    expect(layout.rail.value).toBe(true);
  });
  it('falls back to the rail without a title when matchMedia is missing', () => {
    const layout = setup();
    expect(layout.rail.value).toBe(true);
    expect(layout.showTitle.value).toBe(false);
  });
});
