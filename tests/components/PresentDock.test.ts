// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import PresentDock from '@/components/presenter/PresentDock.vue';
import { makeCloud, makeStore } from '../helpers/presentFixtures';
import type { VotingPhase } from '@/composables/useVotingClock';

function setup(over: { rail?: boolean; collapsed?: boolean; phase?: VotingPhase; label?: string } = {}) {
  const cloud = makeCloud();
  const store = makeStore({ clouds: [cloud], currentId: cloud.id });
  const wrapper = mount(PresentDock, {
    attachTo: document.body,
    props: {
      store, cloud, phase: over.phase ?? 'open', label: over.label ?? '', showTitle: false, stormName: 'All-hands', armed: false,
      fullscreen: { supported: true, active: false }, rail: over.rail ?? true, collapsed: over.collapsed ?? false,
    },
  });
  return { wrapper, store };
}
const find = (w: { findAll(sel: string): { text(): string }[] }, sel: string, text: string) => w.findAll(sel).find((b) => b.text() === text) as ReturnType<ReturnType<typeof mount>['find']> | undefined;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PresentDock', () => {
  it('renders the rail with the controls', () => {
    const { wrapper } = setup();
    const aside = wrapper.find('aside[aria-label="Presenter controls"]');
    expect(aside.exists()).toBe(true);
    expect(aside.find('.present-controls').exists()).toBe(true);
    expect(wrapper.find('.dock-bar').exists()).toBe(false);
  });

  it('collapses to a labelled Controls handle, still in the controls landmark, that emits toggle-dock', async () => {
    const { wrapper } = setup({ collapsed: true });
    const h = wrapper.find('aside[aria-label="Presenter controls"] button.dock-handle');
    expect(h.text()).toContain('Controls');
    expect(h.find('.sr-only').text()).toBe('Show');
    expect(wrapper.find('.rail').exists()).toBe(false);
    await h.trigger('click');
    expect(wrapper.emitted('toggle-dock')).toHaveLength(1);
    // Visible against the page: a border in the muted text colour, not the faint divider colour.
    const src = readFileSync('src/components/presenter/PresentDock.vue', 'utf8');
    expect(src).toMatch(/\.dock-handle \{[^}]*border: 2px solid var\(--text-muted\)/);
  });

  it('renders the phone bar as the labelled controls landmark, with the sheet closed', () => {
    const { wrapper } = setup({ rail: false });
    const bar = wrapper.find('aside.dock-bar[aria-label="Presenter controls"]');
    expect(bar.exists()).toBe(true);
    expect(wrapper.find('.rail').exists()).toBe(false);
    expect(bar.find('button[aria-label=Previous]').exists()).toBe(true);
    expect(bar.text()).toContain('Next');
    expect(bar.text()).toContain('Timer');
    expect(find(bar, 'button', 'Controls')).toBeTruthy();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  });

  it('shows the countdown on the timer button while running', () => {
    expect(setup({ rail: false, phase: 'running', label: '1:34' }).wrapper.find('.dock-bar .bar-timer').text()).toBe('1:34');
    expect(setup({ rail: false }).wrapper.find('.dock-bar .bar-timer').text()).toBe('Timer');
  });

  it('has no Timer button on the bar when no cloud is live', () => {
    const store = makeStore({ clouds: [makeCloud()], currentId: null });
    const wrapper = mount(PresentDock, { props: { store, cloud: null, phase: 'open', label: '', showTitle: false, stormName: '', armed: false, fullscreen: { supported: false, active: false }, rail: false, collapsed: false } });
    expect(wrapper.find('.bar-timer').exists()).toBe(false);
    expect(find(wrapper, 'button', 'Controls')).toBeTruthy();
  });

  it('shows the armed hint and status lines on the bar itself, outside the closed sheet', () => {
    const store = makeStore({ clouds: [makeCloud()], currentId: null });
    const cloud = store.clouds.value[0];
    const props = { store, cloud, phase: 'open' as const, label: '', showTitle: false, stormName: '', fullscreen: { supported: false, active: false }, rail: false, collapsed: false };
    const armed = mount(PresentDock, { props: { ...props, armed: true } });
    expect(armed.find('[role=dialog]').exists()).toBe(false);
    expect(armed.find('.dock-bar .bar-status').text()).toContain('Press 1 to 5');
    expect(armed.find('.bar-timer').classes()).toContain('armed');
    const idle = mount(PresentDock, { props: { ...props, armed: false } });
    expect(idle.find('.bar-status').exists()).toBe(false);
    const lines = mount(PresentDock, { props: { ...props, armed: false, barLines: [{ key: 'join', text: 'Join screen showing', tone: 'on' as const }] } });
    expect(lines.find('aside .bar-status').text()).toContain('Join screen showing');
  });

  it('moves focus to a rail control when the sheet closes because the window widened to the rail', async () => {
    const cloud = makeCloud();
    const store = makeStore({ clouds: [cloud], currentId: cloud.id });
    // A parent holding the sheet model, as the panel does.
    const wrapper = mount(PresentDock, {
      attachTo: document.body,
      props: {
        store, cloud, phase: 'open', label: '', showTitle: false, stormName: '', armed: false, fullscreen: { supported: false, active: false }, rail: false, collapsed: false,
        sheet: false, 'onUpdate:sheet': (v: boolean) => wrapper.setProps({ sheet: v }),
      },
    });
    const opener = find(wrapper, 'button', 'Controls')!;
    (opener.element as HTMLElement).focus();
    await opener.trigger('click');
    await tick();
    expect(wrapper.find('[role=dialog]').element.contains(document.activeElement)).toBe(true);
    // What the panel does on widening: the rail replaces the bar and the sheet closes.
    await wrapper.setProps({ rail: true, sheet: false });
    await tick();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).classList.contains('edit-cloud')).toBe(true);
    wrapper.unmount();
  });

  it('opens and closes the Controls sheet, with focus', async () => {
    const { wrapper } = setup({ rail: false });
    const opener = find(wrapper.find('.dock-bar'), 'button', 'Controls')!;
    (opener.element as HTMLElement).focus();
    await opener.trigger('click');
    await tick();
    const sheet = wrapper.find('[role=dialog][aria-label=Controls]');
    expect(sheet.attributes('aria-modal')).toBe('true');
    expect(sheet.find('.present-controls').exists()).toBe(true);
    expect(sheet.text()).toContain('Edit cloud');
    expect(sheet.text()).toContain('15s');
    expect(sheet.find('.cloud-list').exists()).toBe(true);
    expect(sheet.element.contains(document.activeElement)).toBe(true);

    await find(sheet, 'button', 'Close')!.trigger('click');
    await tick();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);

    await opener.trigger('click');
    await find(wrapper.find('[role=dialog]'), 'button', 'Edit cloud')!.trigger('click');
    expect(wrapper.emitted('edit')).toHaveLength(1);
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('steps from the bar and respects canStep', async () => {
    const { wrapper, store } = setup({ rail: false });
    const bar = wrapper.find('.dock-bar');
    await bar.find('.bar-step.prev').trigger('click');
    await bar.find('.bar-step.next').trigger('click');
    expect(store.stepCloud).toHaveBeenNthCalledWith(1, -1);
    expect(store.stepCloud).toHaveBeenNthCalledWith(2, 1);
    (store.canStep as unknown as { mockReturnValue(v: boolean): void }).mockReturnValue(false);
    const w2 = mount(PresentDock, { props: { store, cloud: makeCloud(), phase: 'open', label: '', showTitle: false, stormName: '', armed: false, fullscreen: { supported: false, active: false }, rail: false, collapsed: false } });
    expect(w2.find('.bar-step.prev').attributes('disabled')).toBeDefined();
    expect(w2.find('.bar-step.next').attributes('disabled')).toBeDefined();
  });

  it('keeps touch targets large', () => {
    const dock = readFileSync('src/components/presenter/PresentDock.vue', 'utf8');
    expect(dock).toMatch(/\.bar-step[^{]*\{[^}]*min-height:\s*44px/);
    const css = readFileSync('src/assets/styles.css', 'utf8');
    expect(css).toMatch(/\.word-chip button\s*\{[^}]*min-width:\s*32px;\s*min-height:\s*32px/);
  });
});
