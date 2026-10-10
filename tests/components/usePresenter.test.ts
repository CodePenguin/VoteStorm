// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import type { AdminStormData } from '@/shared/types';

const signedMock = vi.fn();
vi.mock('@/lib/adminRequest', () => ({ signedApi: (...a: unknown[]) => signedMock(...a) }));
vi.mock('@/lib/adminKeys', () => ({
  describeSecret: async () => ({ secret: 'x', publicKey: 'PUB', resultsKey: 'RESKEY', resultsKeyHash: 'HASH' }),
  generateAdminSecret: async () => ({ secret: 'y', publicKey: 'PUB2', resultsKey: 'RES2', resultsKeyHash: 'HASH2' }),
}));
const renameRemembered = vi.fn();
vi.mock('@/lib/recentStorms', () => ({ renameRemembered: (...a: unknown[]) => renameRemembered(...a) }));
vi.mock('@/composables/useClipboard', () => ({ copyText: async () => true }));

import { usePresenter } from '@/composables/usePresenter';

const stormData = (code: string) =>
  ({
    storm: { storm_code: code, status: 'lobby', current_cloud_id: null, name: null },
    clouds: [],
    showConnect: false,
    license: { tier: 'anonymous', name: 'Anonymous', expiresAt: null, limits: { stormInactivityHours: 24 } },
  }) as unknown as AdminStormData;

/** A promise the test settles by hand, so a request can stay in flight while the page moves to another Storm. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('usePresenter when the link moves to another Storm mid-request', () => {
  let session: ReturnType<typeof ref<{ stormCode: string; secret: string }>>;
  let store: ReturnType<typeof usePresenter>;
  // Set by a test to hold the next PATCH or the next admin-storm GET in flight.
  let patchGate: ReturnType<typeof deferred> | null;
  let loadGate: ReturnType<typeof deferred> | null;

  beforeEach(async () => {
    signedMock.mockReset();
    renameRemembered.mockReset();
    patchGate = null;
    loadGate = null;
    signedMock.mockImplementation(async (s: { stormCode: string }, fn: string, init: RequestInit = {}) => {
      if (init.method === 'PATCH' && patchGate) {
        const gate = patchGate;
        patchGate = null;
        return gate.promise;
      }
      if (fn === 'admin-storm' && !init.method) {
        if (loadGate) {
          const gate = loadGate;
          loadGate = null;
          return gate.promise;
        }
        return stormData(s.stormCode);
      }
      return { ok: true };
    });
    session = ref({ stormCode: 'AAAAAAAA', secret: 's1' });
    store = usePresenter(session as never);
    await store.load();
  });

  /** What the page does when the route changes: switch the session, forget the old Storm, load the new one. */
  async function moveToStormB() {
    session.value = { stormCode: 'BBBBBBBB', secret: 's2' };
    store.reset();
    await store.load();
    expect(store.storm.value?.storm_code).toBe('BBBBBBBB');
  }

  it('does not rename the new Storm, or its remembered entry, when a rename for the old one finishes late', async () => {
    patchGate = deferred();
    const gate = patchGate;
    const naming = store.setName('Old name');
    await moveToStormB();
    gate.resolve({ ok: true });
    await naming;

    expect(store.storm.value?.name).toBeNull();
    expect(renameRemembered).not.toHaveBeenCalled();
    expect(store.error.value).toBeNull();
  });

  it('does not change the new Storm when a join-screen or background change for the old one finishes late', async () => {
    patchGate = deferred();
    const gate = patchGate;
    const connecting = store.setConnect(true);
    await moveToStormB();
    gate.resolve({ ok: true });
    await connecting;
    expect(store.showConnect.value).toBe(false);

    patchGate = deferred();
    const gate2 = patchGate;
    const coloring = store.setResultsBackground('#102030');
    session.value = { stormCode: 'CCCCCCCC', secret: 's3' };
    store.reset();
    await store.load();
    gate2.resolve({ ok: true });
    await coloring;
    expect(store.resultsBackground.value).toBeNull();
  });

  it('does not show a failure for an old Storm’s action on the new Storm', async () => {
    patchGate = deferred();
    const gate = patchGate;
    const closing = store.closeStorm();
    await moveToStormB();
    gate.reject(new Error('old Storm failed'));
    await closing;

    expect(store.error.value).toBeNull();
  });

  it('does not reload the new Storm just because an old Storm’s action finished', async () => {
    patchGate = deferred();
    const gate = patchGate;
    const closing = store.closeStorm();
    await moveToStormB();
    const loadsBefore = signedMock.mock.calls.filter((c) => c[1] === 'admin-storm' && !c[2]?.method).length;
    gate.resolve({ ok: true });
    await closing;

    const loadsAfter = signedMock.mock.calls.filter((c) => c[1] === 'admin-storm' && !c[2]?.method).length;
    expect(loadsAfter).toBe(loadsBefore);
  });

  it('does not clear the new Storm’s error when an old refresh finishes late', async () => {
    loadGate = deferred();
    const gate = loadGate;
    const refreshing = store.safeLoad();
    session.value = { stormCode: 'BBBBBBBB', secret: 's2' };
    store.reset();
    await store.load();
    // The new Storm gets a real problem to show.
    const failGate = deferred();
    patchGate = failGate;
    const failing = store.closeStorm();
    failGate.reject(new Error('boom'));
    await failing;
    expect(store.error.value).toBe('boom');

    gate.resolve(stormData('AAAAAAAA'));
    await refreshing;

    expect(store.error.value).toBe('boom');
    expect(store.storm.value?.storm_code).toBe('BBBBBBBB');
  });

  it('removes and restores a word with a signed PATCH, then reloads', async () => {
    const cloud = { id: 7 } as never;
    const loads = () => signedMock.mock.calls.filter((c) => c[1] === 'admin-storm' && !c[2]?.method).length;
    const before = loads();
    expect(await store.hideWord(cloud, 'rude')).toBe(true);
    expect(await store.showWord(cloud, 'rude')).toBe(true);
    const patches = signedMock.mock.calls.filter((c) => c[1] === 'admin-clouds' && c[2]?.method === 'PATCH').map((c) => JSON.parse(c[2].body));
    expect(patches).toEqual([{ cloudId: 7, hideWord: 'rude' }, { cloudId: 7, showWord: 'rude' }]);
    expect(loads()).toBe(before + 2);
  });

  it('shows the error and returns false when removing a word fails', async () => {
    const gate = deferred();
    patchGate = gate;
    const removing = store.hideWord({ id: 7 } as never, 'rude');
    gate.reject(new Error('nope'));
    expect(await removing).toBe(false);
    expect(store.error.value).toBe('nope');
  });

  it('still applies a change for the current Storm normally', async () => {
    await store.setName('Mine');
    expect(store.storm.value?.name).toBe('Mine');
    expect(renameRemembered).toHaveBeenCalledWith('AAAAAAAA', 'Mine');
  });
});
