// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h as vh, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { handlePresentKey, isTypingTarget, TIMER_KEYS, usePresentKeys, type PresentKeyHandlers } from '@/composables/usePresentKeys';

const handlers = () => ({ prev: vi.fn(), next: vi.fn(), arm: vi.fn(), startTimer: vi.fn(), toggleResults: vi.fn(), toggleJoin: vi.fn(), edit: vi.fn(), fullscreen: vi.fn(), dock: vi.fn(), escape: vi.fn() }) satisfies PresentKeyHandlers;
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
};
const idle = { overlayOpen: false, armed: false };

describe('handlePresentKey', () => {
  it.each([
    ['ArrowLeft', 'prev'], ['ArrowRight', 'next'], ['t', 'arm'], ['T', 'arm'], ['h', 'toggleResults'], ['H', 'toggleResults'],
    ['j', 'toggleJoin'], ['e', 'edit'], ['f', 'fullscreen'], ['d', 'dock'], ['Escape', 'escape'],
  ] as const)('%s calls %s and stops the browser acting on it', (k, name) => {
    const hs = handlers();
    const e = key(k);
    expect(handlePresentKey(e, hs, idle)).toBe(true);
    expect(hs[name]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
  it('starts a timer from 1 to 5 only while armed', () => {
    const hs = handlers();
    expect(handlePresentKey(key('2'), hs, idle)).toBe(false);
    expect(hs.startTimer).not.toHaveBeenCalled();
    TIMER_KEYS.forEach((_seconds, i) => handlePresentKey(key(String(i + 1)), hs, { overlayOpen: false, armed: true }));
    expect(hs.startTimer.mock.calls.map((c) => c[0])).toEqual([15, 30, 60, 120, 300]);
    expect(handlePresentKey(key('6'), hs, { overlayOpen: false, armed: true })).toBe(false);
  });
  it('ignores unrelated keys and any key with Ctrl, Meta or Alt (browser and screen reader shortcuts)', () => {
    const hs = handlers();
    expect(handlePresentKey(key('x'), hs, idle)).toBe(false);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(handlePresentKey(key('h', { [mod]: true }), hs, idle)).toBe(false);
      expect(handlePresentKey(key('ArrowRight', { [mod]: true }), hs, idle)).toBe(false);
    }
    expect(hs.toggleResults).not.toHaveBeenCalled();
    expect(hs.next).not.toHaveBeenCalled();
  });
  it('never fires while typing in a field (Review Focus 1)', () => {
    const hs = handlers();
    for (const tag of ['input', 'textarea', 'select']) {
      const field = document.createElement(tag);
      for (const k of ['h', 'j', 'e', 'f', 'd', 't', '1', 'ArrowLeft', 'ArrowRight', 'Escape']) {
        expect(handlePresentKey(key(k, {}, field), hs, { overlayOpen: false, armed: true })).toBe(false);
      }
    }
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(handlePresentKey(key('h', {}, editable), hs, idle)).toBe(false);
    Object.values(hs).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
  it('with the edit overlay open only Escape acts, and not while typing', () => {
    const hs = handlers();
    const open = { overlayOpen: true, armed: false };
    for (const k of ['ArrowRight', 'h', 'e', 'j', 'f', 'd', 't']) expect(handlePresentKey(key(k), hs, open)).toBe(false);
    expect(handlePresentKey(key('Escape', {}, document.createElement('textarea')), hs, open)).toBe(false);
    expect(hs.escape).not.toHaveBeenCalled();
    expect(handlePresentKey(key('Escape'), hs, open)).toBe(true);
    expect(hs.escape).toHaveBeenCalledTimes(1);
    Object.entries(hs).filter(([n]) => n !== 'escape').forEach(([, fn]) => expect(fn).not.toHaveBeenCalled());
  });
  it('acts once per press: a held key (auto-repeat) never repeats a shortcut, arrows included', () => {
    const hs = handlers();
    for (const k of ['ArrowRight', 'ArrowLeft', 'h', 'j', 'f', 'd', 't', 'e', 'Escape']) {
      const e = key(k, { repeat: true });
      expect(handlePresentKey(e, hs, idle)).toBe(false);
    }
    expect(handlePresentKey(key('2', { repeat: true }), hs, { overlayOpen: false, armed: true })).toBe(false);
    Object.values(hs).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(handlePresentKey(key('ArrowRight'), hs, idle)).toBe(true);
    expect(hs.next).toHaveBeenCalledTimes(1);
  });
  it('ignores a key while an input method is composing, or one another handler already took', () => {
    const hs = handlers();
    expect(handlePresentKey(key('h', { isComposing: true }), hs, idle)).toBe(false);
    expect(handlePresentKey(key('Escape', { isComposing: true }), hs, idle)).toBe(false);
    const taken = key('j');
    taken.preventDefault();
    expect(handlePresentKey(taken, hs, idle)).toBe(false);
    Object.values(hs).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
  it('handles events whose target is the window or document, not an element', () => {
    const hs = handlers();
    expect(handlePresentKey(key('h', {}, window), hs, idle)).toBe(true);
    expect(handlePresentKey(key('j', {}, document), hs, idle)).toBe(true);
    expect(hs.toggleResults).toHaveBeenCalledTimes(1);
    expect(hs.toggleJoin).toHaveBeenCalledTimes(1);
  });
});

describe('isTypingTarget', () => {
  it('recognises form fields and editable elements only', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
  });
});

describe('usePresentKeys', () => {
  const mountWith = (active: () => boolean) => {
    const hs = handlers();
    const wrapper = mount(defineComponent({ setup() { usePresentKeys(hs, () => idle, active); return () => vh('div'); } }));
    return { hs, wrapper };
  };
  it('listens while active, ignores keys while inactive, and stops on unmount', () => {
    const on = ref(true);
    const { hs, wrapper } = mountWith(() => on.value);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(hs.next).toHaveBeenCalledTimes(1);
    on.value = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(hs.next).toHaveBeenCalledTimes(1);
    on.value = true;
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(hs.next).toHaveBeenCalledTimes(1);
  });
  it('steps once for a held arrow on the window', () => {
    const { hs, wrapper } = mountWith(() => true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    for (let i = 0; i < 5; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, cancelable: true }));
    expect(hs.next).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
