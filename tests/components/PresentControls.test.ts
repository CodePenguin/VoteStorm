// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import PresentControls from '@/components/presenter/PresentControls.vue';
import { makeCloud, makeStore } from '../helpers/presentFixtures';
import type { AdminCloud } from '@/shared/types';
import type { VotingPhase } from '@/composables/useVotingClock';

const words = (over: Partial<AdminCloud> = {}) => makeCloud({ kind: 'words', body: 'One word', options: null, tally: { words: [], totalVotes: 7 } as never, ...over } as never);
const content = (over: Partial<AdminCloud> = {}) => makeCloud({ kind: 'content', body: 'Just reading', options: null, tally: { totalVotes: 0 } as never, ...over } as never);

function setup(cloud: AdminCloud | null, over: { clouds?: AdminCloud[]; phase?: VotingPhase; label?: string; showTitle?: boolean; armed?: boolean; fullscreen?: { supported: boolean; active: boolean }; showConnect?: boolean } = {}) {
  const store = makeStore({ clouds: over.clouds ?? (cloud ? [cloud] : []), currentId: cloud?.id ?? null, showConnect: over.showConnect });
  const wrapper = mount(PresentControls, {
    props: {
      store, cloud, phase: over.phase ?? 'open', label: over.label ?? '', showTitle: over.showTitle ?? false, stormName: 'All-hands', armed: over.armed ?? false,
      fullscreen: over.fullscreen ?? { supported: true, active: false },
    },
  });
  return { wrapper, store };
}
const btn = (w: ReturnType<typeof setup>['wrapper'], text: string) => w.findAll('button').find((b) => b.text() === text);

describe('PresentControls', () => {
  it('shows the title block only when asked', () => {
    const on = setup(makeCloud(), { showTitle: true }).wrapper;
    expect(on.text()).toContain('All-hands');
    expect(on.find('.present-title').text()).toContain('VoteStorm');
    const off = setup(makeCloud(), { showTitle: false }).wrapper;
    expect(off.text()).not.toContain('All-hands');
    expect(off.find('.present-title').exists()).toBe(false);
  });

  it('counts the live cloud, or says none is live', () => {
    const clouds = Array.from({ length: 12 }, (_, i) => makeCloud({ id: 100 + i, body: `Q ${i + 1}` }));
    expect(setup(clouds[2], { clouds }).wrapper.text()).toContain('Cloud 3 of 12');
    const none = setup(null, { clouds }).wrapper;
    expect(none.text()).toContain('No cloud is live');
    expect(none.text()).not.toMatch(/Cloud \d+ of/);
  });

  it('shows the status chips', () => {
    const { wrapper } = setup(makeCloud());
    expect(wrapper.text()).toContain('Voting open');
    expect(wrapper.text()).toContain('Join screen off');
  });

  it('steps with Previous and Next, and disables them when it cannot', async () => {
    const { wrapper, store } = setup(makeCloud());
    await btn(wrapper, '‹ Previous')!.trigger('click');
    await btn(wrapper, 'Next ›')!.trigger('click');
    expect(store.stepCloud).toHaveBeenNthCalledWith(1, -1);
    expect(store.stepCloud).toHaveBeenNthCalledWith(2, 1);
    (store.canStep as unknown as { mockImplementation(f: (d: number) => boolean): void }).mockImplementation((d) => d > 0);
    const w2 = mount(PresentControls, { props: { store, cloud: makeCloud(), phase: 'open', label: '', showTitle: false, stormName: '', armed: false, fullscreen: { supported: false, active: false } } });
    expect(btn(w2, '‹ Previous')!.attributes('disabled')).toBeDefined();
    expect(btn(w2, 'Next ›')!.attributes('disabled')).toBeUndefined();
  });

  it('starts timers from the chips, extends and cancels a running one, clears on content', async () => {
    const c = makeCloud();
    const { wrapper, store } = setup(c);
    for (const t of ['15s', '30s', '1m', '2m', '5m']) await btn(wrapper, t)!.trigger('click');
    expect((store.startTimer as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((x) => x[1])).toEqual([15, 30, 60, 120, 300]);
    expect(btn(wrapper, '+30s')).toBeUndefined();

    const run = setup(c, { phase: 'running', label: '0:30' });
    await btn(run.wrapper, '+30s')!.trigger('click');
    expect(run.store.addTime).toHaveBeenCalledWith(c, 30);
    await btn(run.wrapper, 'Cancel timer')!.trigger('click');
    expect(run.store.lockVoting).toHaveBeenCalledWith(c, false);

    const ct = content();
    const cr = setup(ct, { phase: 'running', label: '0:30' });
    await btn(cr.wrapper, 'Clear timer')!.trigger('click');
    expect(cr.store.clearTimer).toHaveBeenCalledWith(ct);
    expect(cr.wrapper.text()).not.toMatch(/Lock/);

    expect(setup(c, { armed: true }).wrapper.text()).toContain('Press 1 to 5');
    expect(setup(c).wrapper.text()).not.toContain('Press 1 to 5');
  });

  it('has the audience toggles for each kind', async () => {
    const q = makeCloud({ correct: JSON.stringify([1]) } as never);
    const { wrapper, store } = setup(q);
    await btn(wrapper, 'Hide results')!.trigger('click');
    expect(store.setCloudFlag).toHaveBeenCalledWith({ cloudId: q.id, resultsHidden: true });
    await btn(wrapper, 'Reveal answer')!.trigger('click');
    expect(store.setCloudFlag).toHaveBeenCalledWith({ cloudId: q.id, answerShown: true });
    await btn(wrapper, 'Show join screen')!.trigger('click');
    expect(store.setConnect).toHaveBeenCalledWith(true);

    const h = setup(makeCloud({ results_hidden: 1, answer_shown: 1, correct: JSON.stringify([0]) } as never), { showConnect: true }).wrapper;
    expect(btn(h, 'Show results')).toBeTruthy();
    expect(btn(h, 'Hide answer')).toBeTruthy();
    expect(btn(h, 'Hide join screen')).toBeTruthy();

    expect(btn(setup(makeCloud()).wrapper, 'Reveal answer')).toBeUndefined();
    const c = setup(content()).wrapper;
    expect(btn(c, 'Hide results')).toBeUndefined();
    expect(btn(c, 'Reveal answer')).toBeUndefined();
    expect(btn(c, 'Show join screen')).toBeTruthy();
    expect(btn(setup(null).wrapper, 'Show join screen')).toBeTruthy();
  });

  it('leaves out the timer-actions grid when it would be empty, and uses h2 section headings', () => {
    const grids = (w: ReturnType<typeof setup>['wrapper']) => w.findAll('.present-grid2').length;
    const open = setup(makeCloud()).wrapper;
    const running = setup(makeCloud(), { phase: 'running', label: '0:30' }).wrapper;
    expect(grids(running)).toBe(grids(open) + 1);
    expect(grids(setup(makeCloud(), { phase: 'closed' }).wrapper)).toBe(grids(open));
    expect(grids(setup(content(), { phase: 'closed' }).wrapper)).toBe(grids(setup(content()).wrapper) + 1);
    expect(open.findAll('.present-grid2').every((g) => g.findAll('button').length > 0)).toBe(true);
    expect(open.findAll('h2').map((x) => x.text())).toEqual(['Timer', 'Audience sees', 'Clouds']);
    expect(open.find('h3').exists()).toBe(false);
  });

  it('locks per kind', async () => {
    const q = makeCloud();
    const a = setup(q);
    await btn(a.wrapper, 'Lock voting')!.trigger('click');
    expect(a.store.lockVoting).toHaveBeenCalledWith(q, true);
    expect(btn(setup(q, { phase: 'closed' }).wrapper, 'Unlock voting')).toBeTruthy();
    expect(btn(setup(q, { phase: 'running', label: '0:10' }).wrapper, 'Lock now')).toBeTruthy();
    expect(btn(setup(words()).wrapper, 'Lock submissions')).toBeTruthy();
    expect(btn(setup(words(), { phase: 'closed' }).wrapper, 'Unlock submissions')).toBeTruthy();
    expect(setup(content()).wrapper.text()).not.toMatch(/Lock|Unlock/);
  });

  it('lists the clouds', async () => {
    const clouds = [
      makeCloud({ id: 1, body: '# Welcome **all**', kind: 'content', options: null, tally: { totalVotes: 0 } as never } as never),
      makeCloud({ id: 2, body: 'How is the team?' }),
      words({ id: 3, body: 'One word' }),
    ];
    const { wrapper, store } = setup(clouds[1], { clouds });
    const items = wrapper.findAll('.cloud-list .li');
    expect(items).toHaveLength(3);
    expect(items[0].text()).toContain('1');
    expect(items[0].text()).toContain('Welcome all');
    expect(items[0].text()).not.toContain('#');
    expect(items[1].classes()).toContain('live');
    expect(items[1].text()).toContain('Live');
    expect(items[1].find('.li-count').text()).toBe('4');
    expect(items[0].find('.li-count').text()).toBe('');
    expect(items[0].text()).not.toContain('Copy link');
    expect(items[1].text()).toContain('Copy link');
    expect(items[2].text()).toContain('Copy link');
    expect(items[1].text()).not.toContain('Go live');
    await items[2].findAll('button').find((b) => b.text() === 'Go live')!.trigger('click');
    expect(store.activate).toHaveBeenCalledWith(3);
    await items[1].findAll('button').find((b) => b.text() === 'Copy link')!.trigger('click');
    expect(store.copyCloudLink).toHaveBeenCalledWith(clouds[1]);
    expect(wrapper.find('nav[aria-label="Clouds"]').exists()).toBe(true);
  });

  it('emits edit, exit and fullscreen, and disables Edit with no live cloud', async () => {
    const { wrapper } = setup(makeCloud());
    await btn(wrapper, 'Edit cloud')!.trigger('click');
    await btn(wrapper, 'Exit')!.trigger('click');
    await btn(wrapper, 'Full screen')!.trigger('click');
    expect(wrapper.emitted('edit')).toHaveLength(1);
    expect(wrapper.emitted('exit')).toHaveLength(1);
    expect(wrapper.emitted('fullscreen')).toHaveLength(1);
    await btn(wrapper, 'Hide controls')!.trigger('click');
    expect(wrapper.emitted('dock')).toHaveLength(1);
    expect(btn(setup(makeCloud(), { fullscreen: { supported: true, active: true } }).wrapper, 'Exit full screen')).toBeTruthy();
    expect(btn(setup(makeCloud(), { fullscreen: { supported: false, active: false } }).wrapper, 'Full screen')).toBeUndefined();
    expect(btn(setup(null).wrapper, 'Edit cloud')!.attributes('disabled')).toBeDefined();
  });

  it('lists the keyboard shortcuts in a details element', () => {
    const d = setup(makeCloud()).wrapper.find('details');
    expect(d.find('summary').text()).toBe('Keyboard shortcuts');
    for (const k of ['T', '1', 'H', 'J', 'E', 'F', 'D', 'Esc']) expect(d.text()).toContain(k);
  });

  it('keeps the rail buttons inside their equal columns (checked at 1280x720 and 1440x900 in a browser)', () => {
    const src = readFileSync('src/components/presenter/PresentControls.vue', 'utf8');
    // Plain 1fr columns grow to fit "‹ Previous" and the pair became unequal; minmax(0, 1fr) keeps them equal halves.
    expect(src).toMatch(/\.present-grid2 \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(src).toMatch(/\.present-step \.btn \{[^}]*padding-left: 8px; padding-right: 8px;/);
    // One line per cloud in the rail (checked in a browser): the row does not wrap, and Copy link shrinks to an icon.
    expect(src).not.toMatch(/\.rail \.cloud-list \.li \{[^}]*flex-wrap: wrap/);
    expect(src).toMatch(/\.rail \.cloud-list \.copy-icon \{ display: block; \}/);
  });
});
