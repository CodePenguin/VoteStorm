// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import PresentPanel from '@/components/presenter/PresentPanel.vue';
import { makeCloud, makeStore } from '../helpers/presentFixtures';
import type { AdminCloud } from '@/shared/types';

const mounted: ReturnType<typeof mount>[] = [];
function setup(over: { clouds?: AdminCloud[]; currentId?: number | null; editing?: boolean; showConnect?: boolean } = {}) {
  const clouds = over.clouds ?? [makeCloud({ id: 1, body: 'First' }), makeCloud({ id: 2, body: 'Second' }), makeCloud({ id: 3, body: 'Third' })];
  const store = makeStore({ clouds, currentId: over.currentId === undefined ? clouds[0]?.id ?? null : over.currentId, showConnect: over.showConnect });
  const wrapper = mount(PresentPanel, { attachTo: document.body, props: { store, editing: over.editing ?? false, stormName: 'All-hands, Q3 planning' } });
  mounted.push(wrapper);
  return { wrapper, store, clouds };
}
const press = async (key: string, target: EventTarget = window) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await nextTick();
};
const btn = (w: ReturnType<typeof mount>, text: string) => w.findAll('button').find((b) => b.text() === text);
const tick = () => new Promise((r) => setTimeout(r, 0));
const setFullscreenElement = (el: Element | null) => Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });

/** A window that can be resized: matchMedia answers from its size and tells listeners when it changes. */
type Listener = (e: { matches: boolean }) => void;
function resizableWindow(size: { width: number; height: number }) {
  const lists: { listeners: Set<Listener>; matches: () => boolean }[] = [];
  const test = (query: string) => {
    const min = (name: string) => Number(new RegExp(`min-${name}:\\s*(\\d+)px`).exec(query)?.[1] ?? 0);
    return size.width >= min('width') && size.height >= min('height');
  };
  window.matchMedia = vi.fn((query: string) => {
    const entry = { listeners: new Set<Listener>(), matches: () => test(query) };
    lists.push(entry);
    return {
      get matches() { return entry.matches(); }, media: query,
      addEventListener: (_: string, l: Listener) => entry.listeners.add(l),
      removeEventListener: (_: string, l: Listener) => entry.listeners.delete(l),
    } as unknown as MediaQueryList;
  });
  return async (width: number, height: number) => {
    size.width = width;
    size.height = height;
    lists.forEach((l) => l.listeners.forEach((fn) => fn({ matches: l.matches() })));
    await nextTick();
  };
}

/** A phone-sized window: no rail, no title. */
function phone() {
  window.matchMedia = vi.fn((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
}

describe('PresentPanel', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    mounted.splice(0).forEach((w) => {
      try {
        w.unmount();
      } catch {
        /* already unmounted by the test */
      }
    });
    delete (window as { matchMedia?: unknown }).matchMedia;
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    setFullscreenElement(null);
    vi.useRealTimers();
  });

  it('has a top-level main stage holding the screen-reader heading, and the dock as a labelled aside', async () => {
    const { wrapper, store } = setup();
    const root = wrapper.find('.present-stage');
    expect(root.attributes('role')).toBeUndefined();
    const main = root.find('main.stage');
    expect(main.find('h1.sr-only').text()).toBe('Presenting');
    expect(main.text()).toContain('First');
    expect(root.findAll('[role=region], section[aria-label]')).toHaveLength(0);
    expect(root.find('aside[aria-label="Presenter controls"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Now showing');
    store.error.value = 'Oops';
    await nextTick();
    expect(main.find('[role=alert]').exists()).toBe(true);
    // The footer behind the stage leaves the Tab order while presenting.
    const css = readFileSync('src/components/presenter/PresentPanel.vue', 'utf8');
    expect(css).toMatch(/html\.presenting \.app-footer \{ display: none; \}/);
  });

  it('steps with the arrow keys, only when the store can', async () => {
    const { store } = setup();
    await press('ArrowRight');
    await press('ArrowLeft');
    expect(store.stepCloud).toHaveBeenNthCalledWith(1, 1);
    expect(store.stepCloud).toHaveBeenNthCalledWith(2, -1);
    (store.canStep as unknown as { mockReturnValue(v: boolean): void }).mockReturnValue(false);
    await press('ArrowRight');
    expect(store.stepCloud).toHaveBeenCalledTimes(2);
  });

  it('H toggles the results, J the join screen, E asks to edit the live cloud', async () => {
    const { wrapper, store, clouds } = setup();
    await press('h');
    expect(store.setCloudFlag).toHaveBeenCalledWith({ cloudId: clouds[0].id, resultsHidden: true });
    await press('j');
    expect(store.setConnect).toHaveBeenCalledWith(true);
    await press('E');
    expect(wrapper.emitted('edit')).toHaveLength(1);
  });

  it('E and H do nothing when no cloud is live, and H does nothing on a content cloud', async () => {
    const none = setup({ currentId: null });
    await press('e');
    await press('h');
    expect(none.wrapper.emitted('edit')).toBeUndefined();
    expect(none.store.setCloudFlag).not.toHaveBeenCalled();
    none.wrapper.unmount();
    const content = setup({ clouds: [makeCloud({ id: 7, kind: 'content', body: 'Read me', options: null, tally: { totalVotes: 0 } as never } as never)] });
    await press('h');
    expect(content.store.setCloudFlag).not.toHaveBeenCalled();
  });

  it('D collapses the dock to a handle, remembers it, and restores it on the next visit', async () => {
    const first = setup();
    await press('d');
    expect(first.wrapper.find('.rail').exists()).toBe(false);
    expect(first.wrapper.find('button.dock-handle').exists()).toBe(true);
    expect(localStorage.getItem('votestorm_dock_collapsed')).toBe('1');
    // Arrows still step while it is collapsed.
    await press('ArrowRight');
    expect(first.store.stepCloud).toHaveBeenCalledWith(1);
    first.wrapper.unmount();

    const second = setup();
    expect(second.wrapper.find('.rail').exists()).toBe(false);
    await second.wrapper.find('button.dock-handle').trigger('click');
    expect(second.wrapper.find('.rail').exists()).toBe(true);
    expect(localStorage.getItem('votestorm_dock_collapsed')).toBeNull();
  });

  it('T arms the timer keys: 3 starts one minute, and the hint goes away', async () => {
    vi.useFakeTimers();
    const { wrapper, store, clouds } = setup();
    await press('3');
    expect(store.startTimer).not.toHaveBeenCalled();
    await press('t');
    expect(wrapper.text()).toContain('Press 1 to 5');
    await press('3');
    expect(store.startTimer).toHaveBeenCalledWith(clouds[0], 60);
    expect(wrapper.text()).not.toContain('Press 1 to 5');

    await press('t');
    expect(wrapper.text()).toContain('Press 1 to 5');
    vi.advanceTimersByTime(3900);
    await nextTick();
    expect(wrapper.text()).toContain('Press 1 to 5');
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.text()).not.toContain('Press 1 to 5');
    await press('2');
    expect(store.startTimer).toHaveBeenCalledTimes(1);
  });

  it('Escape disarms the timer first, then exits', async () => {
    const { wrapper } = setup();
    await press('t');
    await press('Escape');
    expect(wrapper.text()).not.toContain('Press 1 to 5');
    expect(wrapper.emitted('exit')).toBeUndefined();
    await press('Escape');
    expect(wrapper.emitted('exit')).toHaveLength(1);
  });

  it('never fires a shortcut while typing in a field (Review Focus 1)', async () => {
    const { wrapper, store } = setup();
    const input = document.createElement('input');
    wrapper.find('.present-stage').element.appendChild(input);
    input.focus();
    for (const k of ['h', 'e', 'l', 'p', 'j', 'd', 't', '1', 'f', 'ArrowRight', 'Escape']) await press(k, input);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    for (const k of ['h', 'j', 'e']) await press(k, textarea);
    textarea.remove();
    expect(store.setCloudFlag).not.toHaveBeenCalled();
    expect(store.setConnect).not.toHaveBeenCalled();
    expect(store.stepCloud).not.toHaveBeenCalled();
    expect(store.startTimer).not.toHaveBeenCalled();
    expect(wrapper.emitted('edit')).toBeUndefined();
    expect(wrapper.emitted('exit')).toBeUndefined();
    expect(wrapper.find('aside').exists()).toBe(true);
  });

  it('while the edit overlay is open only Escape outside a field acts, and it closes the overlay instead of exiting', async () => {
    const { wrapper, store } = setup({ editing: true });
    for (const k of ['h', 'j', 'e', 'd', 't', '1', 'f', 'ArrowRight', 'ArrowLeft']) await press(k);
    expect(store.setCloudFlag).not.toHaveBeenCalled();
    expect(store.setConnect).not.toHaveBeenCalled();
    expect(store.stepCloud).not.toHaveBeenCalled();
    expect(store.startTimer).not.toHaveBeenCalled();
    expect(wrapper.emitted('edit')).toBeUndefined();
    expect(wrapper.find('aside').exists()).toBe(true);

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    await press('Escape', field);
    field.remove();
    expect(wrapper.emitted('close-edit')).toBeUndefined();

    await press('Escape');
    expect(wrapper.emitted('close-edit')).toHaveLength(1);
    expect(wrapper.emitted('exit')).toBeUndefined();
  });

  it('opening the edit overlay ends the armed timer keys, so the hint is gone when it closes', async () => {
    vi.useFakeTimers();
    const { wrapper } = setup();
    await press('t');
    expect(wrapper.text()).toContain('Press 1 to 5');
    await wrapper.setProps({ editing: true });
    expect(wrapper.text()).not.toContain('Press 1 to 5');
    await press('Escape');
    expect(wrapper.emitted('close-edit')).toHaveLength(1);
    await wrapper.setProps({ editing: false });
    expect(wrapper.text()).not.toContain('Press 1 to 5');
    // Nothing armed is left: the next Escape leaves.
    await press('Escape');
    expect(wrapper.emitted('exit')).toHaveLength(1);
  });

  it('shows the store error with a Dismiss button that clears it', async () => {
    const { wrapper, store } = setup();
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
    store.error.value = 'Network down';
    await nextTick();
    const alert = wrapper.find('[role=alert]');
    expect(alert.text()).toContain("Couldn't complete that: Network down");
    await btn(wrapper, 'Dismiss')!.trigger('click');
    expect(store.error.value).toBeNull();
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
  });

  it('stops the page scrolling while mounted', () => {
    const { wrapper } = setup();
    expect(document.documentElement.classList.contains('presenting')).toBe(true);
    wrapper.unmount();
    expect(document.documentElement.classList.contains('presenting')).toBe(false);
  });

  it('F toggles real full screen, and leaving Present mode leaves it (Review Focus 5)', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = request;
    document.exitFullscreen = exit;
    const { wrapper } = setup();
    await press('f');
    expect(request).toHaveBeenCalledTimes(1);
    setFullscreenElement(document.documentElement);
    document.dispatchEvent(new Event('fullscreenchange'));
    await nextTick();
    expect(btn(wrapper, 'Exit full screen')).toBeTruthy();
    // The browser's own Esc leaves full screen without leaving Present mode.
    setFullscreenElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    await nextTick();
    expect(wrapper.emitted('exit')).toBeUndefined();
    expect(wrapper.find('.present-stage').exists()).toBe(true);

    setFullscreenElement(document.documentElement);
    wrapper.unmount();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('follows the store when the live cloud changes or disappears (Review Focus 4)', async () => {
    const { wrapper, store, clouds } = setup();
    expect(wrapper.find('.upnext').text()).toContain('Second');
    expect(wrapper.text()).toContain('Cloud 1 of 3');
    store.storm.value!.current_cloud_id = 2;
    await nextTick();
    expect(wrapper.find('.stage').text()).toContain('Second');
    expect(wrapper.find('.upnext').text()).toContain('Third');
    expect(wrapper.text()).toContain('Cloud 2 of 3');
    store.storm.value!.current_cloud_id = 3;
    await nextTick();
    expect(wrapper.find('.upnext').exists()).toBe(false);

    store.clouds.value = clouds.filter((c) => c.id !== 3);
    await nextTick();
    expect(wrapper.find('.stage-empty').text()).toBe('No cloud is live');
    expect(wrapper.find('.upnext').exists()).toBe(false);
    expect(wrapper.find('aside').text()).toContain('No cloud is live');
    await press('h');
    await press('e');
    await press('3');
    expect(store.setCloudFlag).not.toHaveBeenCalled();
    expect(wrapper.emitted('edit')).toBeUndefined();
  });

  describe('on a phone', () => {
    beforeEach(phone);

    it('shows the bar, and a one-line status above it only when something differs from the default', async () => {
      const { wrapper, store } = setup();
      await nextTick(); // the layout is measured on mount
      expect(wrapper.find('.rail').exists()).toBe(false);
      expect(wrapper.find('aside.dock-bar').exists()).toBe(true);
      expect(wrapper.find('.present-title').exists()).toBe(false);
      // Merely open is the default: no line at all.
      expect(wrapper.find('.bar-status').exists()).toBe(false);
      const content = setup({ clouds: [makeCloud({ id: 9, kind: 'content', body: 'Read', options: null, tally: { totalVotes: 0 } as never } as never)] });
      await nextTick();
      expect(content.wrapper.find('.bar-status').exists()).toBe(false);
      store.showConnect.value = true;
      await nextTick();
      expect(wrapper.find('.bar-status').text()).toContain('Join screen showing');
      expect(wrapper.find('.bar-status').text()).not.toContain('Voting open');
      store.clouds.value = [{ ...store.clouds.value[0], results_hidden: 1 }, ...store.clouds.value.slice(1)];
      await nextTick();
      expect(wrapper.find('.bar-status').text()).toContain('Results hidden');
    });

    it('shows a closed cloud on the status line, but not a running timer (the bar\'s Timer button counts down)', async () => {
      const closed = setup({ clouds: [makeCloud({ id: 21, voting_ms_left: 0 } as never)] });
      await nextTick();
      expect(closed.wrapper.find('.bar-status').text()).toContain('Voting closed');
      const running = setup({ clouds: [makeCloud({ id: 22, voting_ms_left: 60000 } as never)] });
      await nextTick();
      expect(running.wrapper.find('.bar-status').exists()).toBe(false);
      expect(running.wrapper.find('.bar-timer').text()).toMatch(/^\d:\d\d$/);
    });

    it('T shows the armed hint on the bar, where it can be seen with the sheet closed', async () => {
      const { wrapper, store, clouds } = setup();
      await nextTick();
      await press('t');
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      expect(wrapper.find('.dock-bar .bar-status').text()).toContain('Press 1 to 5');
      await press('3');
      expect(store.startTimer).toHaveBeenCalledWith(clouds[0], 60);
      expect(wrapper.text()).not.toContain('Press 1 to 5');
    });

    it('D does nothing with the bar, and stores nothing', async () => {
      const { wrapper } = setup();
      await nextTick();
      await press('d');
      expect(localStorage.getItem('votestorm_dock_collapsed')).toBeNull();
      expect(wrapper.find('.dock-bar').exists()).toBe(true);
    });

    it('treats the open Controls sheet like the edit overlay: Escape closes the sheet first and other keys are inert', async () => {
      const { wrapper, store } = setup();
      await nextTick(); // the layout is measured on mount
      const opener = btn(wrapper, 'Controls')!;
      (opener.element as HTMLElement).focus();
      await opener.trigger('click');
      await tick();
      expect(wrapper.find('[role=dialog][aria-label=Controls]').exists()).toBe(true);
      // Focus has left the sheet (a click on the dim edge, a screen reader): keys reach the window.
      (document.activeElement as HTMLElement).blur();
      for (const k of ['h', 'j', 'e', 'd', 'f', 'ArrowRight', 't', '1']) await press(k);
      expect(store.setCloudFlag).not.toHaveBeenCalled();
      expect(store.setConnect).not.toHaveBeenCalled();
      expect(store.stepCloud).not.toHaveBeenCalled();
      expect(store.startTimer).not.toHaveBeenCalled();
      expect(wrapper.emitted('edit')).toBeUndefined();
      expect(wrapper.find('[role=dialog]').exists()).toBe(true);

      await press('Escape');
      await tick();
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      expect(wrapper.emitted('exit')).toBeUndefined();
      expect(document.activeElement).toBe(opener.element);
      await press('Escape');
      expect(wrapper.emitted('exit')).toHaveLength(1);
    });

    it('Escape inside the sheet closes only the sheet', async () => {
      const { wrapper } = setup();
      await nextTick();
      await btn(wrapper, 'Controls')!.trigger('click');
      await tick();
      const sheet = wrapper.find('[role=dialog]');
      await press('Escape', sheet.find('button').element);
      await tick();
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      expect(wrapper.emitted('exit')).toBeUndefined();
    });
  });

  describe('when the window is resized with the Controls sheet open', () => {
    it('closes the sheet on widening to the rail, so the shortcuts work again, and it does not pop back on narrowing', async () => {
      const resize = resizableWindow({ width: 390, height: 844 });
      const { wrapper, store } = setup();
      await nextTick();
      await btn(wrapper, 'Controls')!.trigger('click');
      await tick();
      expect(wrapper.find('[role=dialog][aria-label=Controls]').exists()).toBe(true);
      await press('ArrowRight');
      expect(store.stepCloud).not.toHaveBeenCalled();

      await resize(1280, 800);
      expect(wrapper.find('aside[aria-label="Presenter controls"]').exists()).toBe(true);
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      await press('ArrowRight');
      expect(store.stepCloud).toHaveBeenCalledWith(1);
      await press('h');
      expect(store.setCloudFlag).toHaveBeenCalledTimes(1);
      // The first Escape leaves Present mode: there is no invisible sheet to close.
      await press('Escape');
      expect(wrapper.emitted('exit')).toHaveLength(1);

      await resize(390, 844);
      expect(wrapper.find('.dock-bar').exists()).toBe(true);
      expect(wrapper.find('[role=dialog]').exists()).toBe(false);
      await press('ArrowLeft');
      expect(store.stepCloud).toHaveBeenCalledWith(-1);
    });

    it('moves focus to Edit cloud on the rail, not the page body, when the sheet had focus', async () => {
      const resize = resizableWindow({ width: 390, height: 844 });
      const { wrapper } = setup();
      await nextTick();
      const opener = btn(wrapper, 'Controls')!;
      (opener.element as HTMLElement).focus();
      await opener.trigger('click');
      await tick();
      expect(wrapper.find('[role=dialog]').element.contains(document.activeElement)).toBe(true);
      await resize(1280, 800);
      await tick();
      expect(document.activeElement).not.toBe(document.body);
      expect(wrapper.find('.rail .edit-cloud').element).toBe(document.activeElement);
    });
  });
});
