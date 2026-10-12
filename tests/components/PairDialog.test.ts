// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { loadRecent, mergeRecent, rememberStorm } from '@/lib/recentStorms';
import type { HostState, JoinState } from '@/lib/pairing';
import { retryLabel } from '@/lib/relativeTime';

const { startHost, startJoin, hosts, joins } = vi.hoisted(() => {
  const hosts: Array<{ opts: any; confirm: Mock; cancel: Mock }> = [];
  const joins: Array<{ opts: any; cancel: Mock }> = [];
  return {
    hosts,
    joins,
    startHost: vi.fn((opts: any) => {
      const s = { opts, confirm: vi.fn(), cancel: vi.fn() };
      hosts.push(s);
      return { confirm: s.confirm, cancel: s.cancel };
    }),
    startJoin: vi.fn((opts: any) => {
      const s = { opts, cancel: vi.fn() };
      joins.push(s);
      return { cancel: s.cancel };
    }),
  };
});

vi.mock('@/lib/pairing', async (importActual) => ({ ...(await importActual<typeof import('@/lib/pairing')>()), startHost, startJoin }));
vi.mock('@/composables/usePairTransport', () => ({ openPairTransport: vi.fn() }));

import PairDialog from '@/components/PairDialog.vue';
import { openPairTransport } from '@/composables/usePairTransport';

const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const result = { added: 4, updated: 1, kept: 2 };

let wrapper: VueWrapper | null = null;
async function mountDialog() {
  wrapper = mount(PairDialog, { attachTo: document.body });
  await nextTick();
  await nextTick();
  return wrapper;
}
// jsdom queues a 0 ms timer for the text selection whenever an input takes focus; it is not the dialog's, so it is run before counting.
const dialogTimers = () => {
  vi.advanceTimersByTime(0);
  return vi.getTimerCount();
};
const root = () => wrapper!.find('[role=dialog]');
async function hostState(s: HostState, i = hosts.length - 1) {
  hosts[i].opts.onState(s);
  await nextTick();
}
async function joinState(s: JoinState, i = joins.length - 1) {
  joins[i].opts.onState(s);
  await nextTick();
}
async function typeCode(text: string) {
  await wrapper!.find('input').setValue(text);
  await wrapper!.find('form').trigger('submit');
}

describe('PairDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    localStorage.clear();
    hosts.length = 0;
    joins.length = 0;
    startHost.mockClear();
    startJoin.mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it('hosts on mount with a fresh code, this device\'s Storms, the real transport and merge', async () => {
    rememberStorm({ stormCode: 'AAAA1111', secret: 'SEC-A' });
    await mountDialog();
    expect(startHost).toHaveBeenCalledTimes(1);
    const opts = startHost.mock.calls[0][0];
    expect(opts.code).toMatch(CODE);
    expect(opts.storms).toEqual(loadRecent());
    expect(opts.open).toBe(openPairTransport);
    expect(opts.merge).toBe(mergeRecent);
    expect(root().attributes('data-mode')).toBe('host');
    expect(startJoin).not.toHaveBeenCalled();
    // The code is shown only once the host is listening for it.
    await hostState({ phase: 'connecting' });
    expect(wrapper!.find('output').exists()).toBe(false);
    expect(wrapper!.find('.pair-status').text()).not.toBe('');
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    expect(wrapper!.find('output').text().replace('-', '')).toBe(opts.code);
  });

  it('announces the code through the one status region, and the shown code is not a second live region', async () => {
    await mountDialog();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    const spoken = wrapper!.find('[role=status] .pair-status-code');
    expect(spoken.exists()).toBe(true);
    expect(spoken.text().replace(/[\s,]/g, '')).toBe(hosts[0].opts.code);
    expect(wrapper!.find('output').attributes('aria-live')).toBe('off');
    expect(wrapper!.findAll('[role=status], [aria-live=polite], [aria-live=assertive]')).toHaveLength(1);
    await hostState({ phase: 'ready', count: 0, expiresAt: Date.now() + 30_000 });
    expect(wrapper!.find('.pair-status-code').exists()).toBe(false);
  });

  it('prompts without a count when this device has no Storms to send', async () => {
    await mountDialog();
    await hostState({ phase: 'ready', count: 0, expiresAt: Date.now() + 30_000 });
    expect(wrapper!.find('[role=status]').text()).not.toMatch(/\d/);
    await hostState({ phase: 'ready', count: 3, expiresAt: Date.now() + 30_000 });
    expect(wrapper!.find('[role=status]').text()).toContain('3');
  });

  it('keeps one status region in place across every state', async () => {
    await mountDialog();
    const status = wrapper!.find('[role=status]').element;
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    await hostState({ phase: 'ready', count: 2, expiresAt: Date.now() + 30_000 });
    expect(wrapper!.find('[role=status]').element).toBe(status);
    expect(status.textContent).not.toBe('');
    await hostState({ phase: 'done', result });
    expect(wrapper!.findAll('[role=status]')).toHaveLength(1);
    expect(wrapper!.find('[role=status]').element).toBe(status);
    await wrapper!.find('.pair-close').trigger('click');
    wrapper!.unmount();
    wrapper = await mountDialog();
    const again = wrapper!.find('[role=status]').element;
    await typeCode('ABCDE-12345');
    await joinState({ phase: 'receiving' });
    expect(wrapper!.find('[role=status]').element).toBe(again);
  });

  it('follows the host states, confirms on Sync, disables in sending and emits merged once on done', async () => {
    await mountDialog();
    await hostState({ phase: 'connecting' });
    expect(root().attributes('data-phase')).toBe('connecting');
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    expect(root().attributes('data-phase')).toBe('waiting');
    await hostState({ phase: 'ready', count: 3, expiresAt: Date.now() + 30_000 });
    expect(root().attributes('data-phase')).toBe('ready');
    expect(wrapper!.find('input').exists()).toBe(false);
    expect(wrapper!.find('output').exists()).toBe(false);
    await wrapper!.find('.pair-sync').trigger('click');
    expect(hosts[0].confirm).toHaveBeenCalledTimes(1);
    await hostState({ phase: 'sending' });
    expect(root().attributes('data-phase')).toBe('sending');
    expect(wrapper!.find('.pair-sync').attributes('disabled')).toBeDefined();
    expect(wrapper!.find('.pair-cancel').attributes('disabled')).toBeDefined();
    await hostState({ phase: 'done', result });
    await hostState({ phase: 'done', result });
    expect(root().attributes('data-phase')).toBe('done');
    expect(wrapper!.emitted('merged')).toHaveLength(1);
    expect(wrapper!.find('.pair-close').exists()).toBe(true);
    expect(wrapper!.find('[role=alert]').exists()).toBe(false);
  });

  it('ignores Esc and backdrop clicks while sending, like the disabled Cancel', async () => {
    await mountDialog();
    await hostState({ phase: 'sending' });
    await root().trigger('keydown', { key: 'Escape' });
    await wrapper!.find('.modal-backdrop').trigger('click');
    expect(hosts[0].cancel).not.toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toBeUndefined();
    await hostState({ phase: 'done', result });
    await root().trigger('keydown', { key: 'Escape' });
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('Cancel in ready closes and cancels the host', async () => {
    await mountDialog();
    await hostState({ phase: 'ready', count: 3, expiresAt: Date.now() + 30_000 });
    await wrapper!.find('.pair-cancel').trigger('click');
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('shows a host failure with its reason, and Try again starts a new host with a different code', async () => {
    await mountDialog();
    await hostState({ phase: 'failed', reason: 'expired' });
    expect(root().attributes('data-phase')).toBe('failed');
    expect(root().attributes('data-reason')).toBe('expired');
    expect(wrapper!.find('.alert.error[role=alert]').exists()).toBe(true);
    await wrapper!.find('.pair-retry').trigger('click');
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(startHost).toHaveBeenCalledTimes(2);
    expect(hosts[1].opts.code).toMatch(CODE);
    expect(hosts[1].opts.code).not.toBe(hosts[0].opts.code);
    expect(root().attributes('data-mode')).toBe('host');
    expect(root().attributes('data-reason')).toBeUndefined();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    expect(wrapper!.find('output').text().replace('-', '')).toBe(hosts[1].opts.code);
  });

  it.each(['wrong_code', 'no_answer', 'expired', 'timeout', 'invalid', 'connection', 'license'] as const)('shows the %s failure as an alert with Try again', async (reason) => {
    await mountDialog();
    await hostState({ phase: 'failed', reason });
    expect(root().attributes('data-reason')).toBe(reason);
    const alert = wrapper!.find('.alert.error[role=alert]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).not.toBe('');
    expect(wrapper!.find('.pair-retry').exists()).toBe(true);
  });

  it.each([
    ['host', 720],
    ['host', undefined],
    ['join', 45],
  ] as const)('shows too many attempts (%s, wait %s) as an alert with Close and no Try again', async (role, wait) => {
    await mountDialog();
    const failed = { phase: 'failed', reason: 'rate_limited', ...(wait === undefined ? {} : { retryAfterSeconds: wait }) } as const;
    if (role === 'join') {
      await typeCode('ABCDE-12345');
      await joinState(failed);
    } else {
      await hostState(failed);
    }
    expect(root().attributes('data-reason')).toBe('rate_limited');
    const alert = wrapper!.find('.alert.error[role=alert]');
    expect(alert.exists()).toBe(true);
    // The wait shown is the helper's, so it follows the server's Retry-After.
    expect(alert.text()).toContain(retryLabel(wait));
    expect(wrapper!.find('.pair-retry').exists()).toBe(false);
    await wrapper!.find('.pair-close').trigger('click');
    expect(wrapper!.emitted('close')).toHaveLength(1);
    expect(startHost).toHaveBeenCalledTimes(1);
  });

  it.each(['abcde-12345', ' AbCdE 12345 ', 'abcde12345', 'ABCDE-l2345'])('joins with the typed code %j, cancelling the host', async (typed) => {
    await mountDialog();
    await typeCode(typed);
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(startJoin).toHaveBeenCalledTimes(1);
    const opts = startJoin.mock.calls[0][0];
    expect(opts.code).toBe('ABCDE12345');
    expect(opts.open).toBe(openPairTransport);
    expect(opts.merge).toBe(mergeRecent);
    expect(opts.list).toBe(loadRecent);
    expect(root().attributes('data-mode')).toBe('join');
    expect(wrapper!.find('output').exists()).toBe(false);
    expect(wrapper!.find('input').exists()).toBe(false);
  });

  it('keeps focus inside the dialog when Connect switches it to joining', async () => {
    await mountDialog();
    await wrapper!.find('input').setValue('ABCDE-12345');
    (wrapper!.find('.pair-connect').element as HTMLElement).focus();
    await wrapper!.find('form').trigger('submit');
    await nextTick();
    await nextTick();
    expect(root().attributes('data-mode')).toBe('join');
    expect(wrapper!.find('.modal').element.contains(document.activeElement)).toBe(true);
  });

  it.each(['abc', 'ABCDE1234U', ''])('refuses the code %j inline without touching the host session', async (typed) => {
    await mountDialog();
    await typeCode(typed);
    expect(wrapper!.find('.pair-input-error').exists()).toBe(true);
    expect(startJoin).not.toHaveBeenCalled();
    expect(hosts[0].cancel).not.toHaveBeenCalled();
    expect(root().attributes('data-mode')).toBe('host');
    expect(wrapper!.find('input').attributes('disabled')).toBeUndefined();
    expect(wrapper!.find('input').attributes('aria-invalid')).toBe('true');
  });

  it('follows the join states and emits merged once on done', async () => {
    await mountDialog();
    await typeCode('ABCDE-12345');
    for (const phase of ['connecting', 'waiting', 'receiving'] as const) {
      await joinState({ phase });
      expect(root().attributes('data-phase')).toBe(phase);
      expect(wrapper!.find('[role=status]').exists()).toBe(true);
    }
    await joinState({ phase: 'done', result: { added: 0, updated: 0, kept: 0 } });
    await joinState({ phase: 'done', result: { added: 0, updated: 0, kept: 0 } });
    expect(root().attributes('data-phase')).toBe('done');
    expect(wrapper!.emitted('merged')).toHaveLength(1);
    expect(wrapper!.find('.pair-close').exists()).toBe(true);
  });

  it('shows a join failure, and Try again cancels it and hosts again', async () => {
    await mountDialog();
    await typeCode('ABCDE-12345');
    await joinState({ phase: 'failed', reason: 'no_answer' });
    expect(root().attributes('data-reason')).toBe('no_answer');
    expect(wrapper!.find('.alert.error[role=alert]').exists()).toBe(true);
    expect(wrapper!.emitted('merged')).toBeUndefined();
    await wrapper!.find('.pair-retry').trigger('click');
    expect(joins[0].cancel).toHaveBeenCalled();
    expect(startHost).toHaveBeenCalledTimes(2);
    expect(root().attributes('data-mode')).toBe('host');
    expect(wrapper!.find('input').exists()).toBe(true);
  });

  it('ignores states from a session it has already left', async () => {
    await mountDialog();
    await typeCode('ABCDE-12345');
    await hostState({ phase: 'failed', reason: 'connection' }, 0);
    expect(root().attributes('data-mode')).toBe('join');
    expect(root().attributes('data-phase')).not.toBe('failed');
  });

  it('counts down the code and stops the countdown when hosting ends', async () => {
    await mountDialog();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    expect(wrapper!.find('.pair-expiry').text()).toContain('2:00');
    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(wrapper!.find('.pair-expiry').text()).toContain('1:57');
    expect(dialogTimers()).toBe(1);
    await hostState({ phase: 'ready', count: 1, expiresAt: Date.now() + 30_000 });
    expect(dialogTimers()).toBe(0);
  });

  it('stops the countdown at 0:00 rather than going negative', async () => {
    await mountDialog();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 2_000 });
    vi.advanceTimersByTime(10_000);
    await nextTick();
    expect(wrapper!.find('.pair-expiry').text()).toContain('0:00');
    expect(wrapper!.find('.pair-expiry').text()).not.toContain('-');
  });

  it.each([
    ['the Close button', async () => wrapper!.find('.pair-close').trigger('click')],
    ['Esc', async () => root().trigger('keydown', { key: 'Escape' })],
    ['a backdrop click', async () => wrapper!.find('.modal-backdrop').trigger('click')],
  ])('closing with %s cancels the active session and emits close', async (_name, act) => {
    await mountDialog();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    await act();
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('closing while joining cancels the join, not just the host', async () => {
    await mountDialog();
    await typeCode('ABCDE-12345');
    await joinState({ phase: 'waiting' });
    await root().trigger('keydown', { key: 'Escape' });
    expect(joins[0].cancel).toHaveBeenCalled();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('unmounting cancels the session and leaves no timer running', async () => {
    await mountDialog();
    await hostState({ phase: 'waiting', expiresAt: Date.now() + 120_000 });
    expect(dialogTimers()).toBe(1);
    wrapper!.unmount();
    wrapper = null;
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(dialogTimers()).toBe(0);
  });

  it('moves focus into the dialog when it opens', async () => {
    await mountDialog();
    expect(wrapper!.find('.modal').element.contains(document.activeElement)).toBe(true);
  });
});
