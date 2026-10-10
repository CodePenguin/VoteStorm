// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref, type VNode } from 'vue';
import { mount } from '@vue/test-utils';
import { focusables, useDialogFocus } from '@/composables/useDialogFocus';

const defaultBody = () => [h('input', { id: 'first' }), h('button', { id: 'last' }, 'Save')];
function setup(opts: { fallback?: () => HTMLElement | null; initiallyOpen?: boolean; body?: () => VNode[] } = {}) {
  const open = ref(opts.initiallyOpen ?? false);
  const Comp = defineComponent({
    setup() {
      const dialog = ref<HTMLElement | null>(null);
      useDialogFocus(dialog, open, opts.fallback);
      return () => h('div', [
        h('button', { id: 'opener' }, 'Open'),
        open.value ? h('div', { ref: dialog, id: 'dialog', tabindex: -1, role: 'dialog' }, (opts.body ?? defaultBody)()) : null,
      ]);
    },
  });
  const wrapper = mount(Comp, { attachTo: document.body });
  return { open, wrapper };
}
const settle = async () => { await nextTick(); await nextTick(); };
const tab = (shiftKey = false) => {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  document.dispatchEvent(e);
  return e;
};

describe('useDialogFocus', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('moves focus into the dialog on open and back to the opener on close', async () => {
    const { open, wrapper } = setup();
    (document.getElementById('opener') as HTMLElement).focus();
    open.value = true;
    await settle();
    expect(document.activeElement?.id).toBe('first');
    open.value = false;
    await settle();
    expect(document.activeElement?.id).toBe('opener');
    wrapper.unmount();
  });
  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { open, wrapper } = setup();
    open.value = true;
    await settle();
    (document.getElementById('last') as HTMLElement).focus();
    const forward = tab();
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('first');
    const back = tab(true);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('last');
    wrapper.unmount();
  });
  it('lets Tab move normally between the dialog controls', async () => {
    const { open, wrapper } = setup();
    open.value = true;
    await settle();
    (document.getElementById('first') as HTMLElement).focus();
    expect(tab().defaultPrevented).toBe(false);
    wrapper.unmount();
  });
  it('falls back to a given control when the opener is gone or nothing had focus', async () => {
    const { open, wrapper } = setup({ fallback: () => document.getElementById('opener') });
    const temp = document.createElement('button');
    document.body.appendChild(temp);
    temp.focus();
    open.value = true;
    await settle();
    temp.remove();
    open.value = false;
    await settle();
    expect(document.activeElement?.id).toBe('opener');

    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    open.value = true;
    await settle();
    open.value = false;
    await settle();
    expect(document.activeElement?.id).toBe('opener');
    wrapper.unmount();
  });
  it('does not take focus at mount while closed', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { wrapper } = setup({ fallback: () => document.getElementById('opener') });
    await settle();
    expect(document.activeElement).toBe(outside);
    wrapper.unmount();
  });
  it('focuses and traps a dialog that is already open when its owner mounts', async () => {
    const { wrapper } = setup({ initiallyOpen: true });
    await settle();
    expect(document.activeElement?.id).toBe('first');
    (document.getElementById('last') as HTMLElement).focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('first');
    wrapper.unmount();
  });
  it('an open-then-close before the dialog renders leaves no Tab trap behind', async () => {
    const { open, wrapper } = setup();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    open.value = true;
    await nextTick(); // the watcher has run and is waiting for the dialog
    open.value = false;
    await settle();
    await settle();
    const calls = (spy: typeof add) => spy.mock.calls.map((c, i) => ({ type: c[0], fn: c[1], order: spy.mock.invocationCallOrder[i] })).filter((c) => c.type === 'keydown');
    const added = calls(add);
    const removed = calls(remove);
    add.mockRestore();
    remove.mockRestore();
    expect(added).toHaveLength(1);
    expect(removed.map((c) => c.fn)).toEqual([added[0].fn]);
    // Removed after it was added, so nothing is left listening.
    expect(removed[0].order).toBeGreaterThan(added[0].order);
    wrapper.unmount();
  });
  it('removes the trap and gives focus back when unmounted while open', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { open, wrapper } = setup();
    open.value = true;
    await settle();
    expect(document.activeElement?.id).toBe('first');
    wrapper.unmount();
    expect(document.activeElement).toBe(outside);
    expect(tab().defaultPrevented).toBe(false);
  });
  it('with nothing focusable, focuses the dialog itself and keeps Tab on it', async () => {
    const { open, wrapper } = setup({ body: () => [h('p', 'Nothing to press')] });
    open.value = true;
    await settle();
    expect(document.activeElement?.id).toBe('dialog');
    expect(tab().defaultPrevented).toBe(true);
    wrapper.unmount();
  });
  it('skips hidden and inert controls', async () => {
    const body = () => [
      h('button', { id: 'gone', hidden: true }, 'Hidden'),
      h('div', { inert: '' }, [h('button', { id: 'inert' }, 'Inert')]),
      h('button', { id: 'invisible', style: 'display: none' }, 'None'),
      h('button', { id: 'real' }, 'Real'),
    ];
    const { open, wrapper } = setup({ body });
    open.value = true;
    await settle();
    expect(document.activeElement?.id).toBe('real');
    expect(focusables(document.getElementById('dialog') as HTMLElement).map((el) => el.id)).toEqual(['real']);
    wrapper.unmount();
  });
});
