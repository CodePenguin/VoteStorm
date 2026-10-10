// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useFullscreen } from '@/composables/useFullscreen';

const setup = () => {
  let fs!: ReturnType<typeof useFullscreen>;
  const wrapper = mount(defineComponent({ setup() { fs = useFullscreen(); return () => h('div'); } }));
  return { fs, wrapper };
};
const setElement = (el: Element | null) => Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });

describe('useFullscreen', () => {
  afterEach(() => { delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen; delete (document as { exitFullscreen?: unknown }).exitFullscreen; setElement(null); });
  it('is unsupported where the browser has no Fullscreen API, and toggle does nothing harmful', async () => {
    const { fs } = setup();
    expect(fs.supported).toBe(false);
    await expect(fs.toggle()).resolves.toBeUndefined();
  });
  it('asks for full screen, and for leaving it when already in it', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = request;
    document.exitFullscreen = exit;
    const { fs } = setup();
    expect(fs.supported).toBe(true);
    await fs.toggle();
    expect(request).toHaveBeenCalled();
    setElement(document.documentElement);
    await fs.toggle();
    expect(exit).toHaveBeenCalled();
  });
  it('tracks the browser changing full screen on its own (Esc)', async () => {
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const { fs } = setup();
    setElement(document.documentElement);
    document.dispatchEvent(new Event('fullscreenchange'));
    await nextTick();
    expect(fs.active.value).toBe(true);
    setElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(fs.active.value).toBe(false);
  });
  it('knows it is already in full screen when mounted there', () => {
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    setElement(document.documentElement);
    const { fs, wrapper } = setup();
    expect(fs.active.value).toBe(true);
    wrapper.unmount();
  });
  it('stops listening on unmount', () => {
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const { fs, wrapper } = setup();
    wrapper.unmount();
    setElement(document.documentElement);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(fs.active.value).toBe(false);
  });
  it('swallows a refusal from the browser', async () => {
    document.documentElement.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    const { fs } = setup();
    await expect(fs.toggle()).resolves.toBeUndefined();
  });
  it('exit() leaves full screen only when in it', async () => {
    const exit = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = vi.fn();
    document.exitFullscreen = exit;
    const { fs } = setup();
    await fs.exit();
    expect(exit).not.toHaveBeenCalled();
    setElement(document.documentElement);
    await fs.exit();
    expect(exit).toHaveBeenCalled();
  });
});
