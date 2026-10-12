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

describe('usePresenter importStorm', () => {
  beforeEach(() => {
    signedMock.mockReset();
    renameRemembered.mockReset();
  });

  it('sends the file signed as admin-import, reloads, and renames the Storm in the recent list', async () => {
    signedMock.mockImplementation(async (_s: unknown, fn: string, init: RequestInit = {}) => {
      if (fn === 'admin-storm' && !init.method) {
        const data = stormData('ABCDEFGH');
        return { ...data, storm: { ...data.storm, name: 'Imported' } };
      }
      return { ok: true };
    });
    const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
    const file = { votestorm: 1, name: 'Imported', clouds: [] };
    expect(await store.importStorm(file)).toEqual({ ok: true });
    const call = signedMock.mock.calls.find((c) => c[1] === 'admin-import')!;
    expect(call[2].method).toBe('POST');
    expect(JSON.parse(call[2].body)).toEqual({ storm: file });
    expect(store.storm.value?.name).toBe('Imported');
    expect(renameRemembered).toHaveBeenCalledWith('ABCDEFGH', 'Imported');
  });

  it('reports the import as done, with the error shown, when only the reload fails', async () => {
    let reads = 0;
    signedMock.mockImplementation(async (_s: unknown, fn: string, init: RequestInit = {}) => {
      if (fn === 'admin-storm' && !init.method && ++reads > 1) throw new Error('offline');
      return fn === 'admin-import' ? { ok: true } : stormData('ABCDEFGH');
    });
    const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
    await store.load();
    expect(await store.importStorm({})).toEqual({ ok: true });
    expect(store.error.value).toBeTruthy();
  });

  it('returns the server\'s reason when the import is refused, leaving the page error alone', async () => {
    signedMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn === 'admin-import') throw new Error('Cloud 3: refused');
      return stormData('ABCDEFGH');
    });
    const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
    store.error.value = 'an earlier problem';
    expect(await store.importStorm({})).toEqual({ ok: false, error: 'Cloud 3: refused' });
    expect(store.error.value).toBe('an earlier problem');
    expect(renameRemembered).not.toHaveBeenCalled();
  });

  it('reports no reason when the page moved to another Storm during the import', async () => {
    for (const outcome of ['refused', 'done']) {
      let finish!: () => void;
      signedMock.mockImplementation(async (_s: unknown, fn: string) => {
        if (fn !== 'admin-import') return stormData('ABCDEFGH');
        await new Promise<void>((r) => (finish = r));
        if (outcome === 'refused') throw new Error('Cloud 3: refused');
        return { ok: true };
      });
      const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
      const importing = store.importStorm({});
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      store.reset();
      finish();
      expect(await importing).toEqual({ ok: false, error: null });
      expect(store.error.value).toBeNull();
    }
    expect(renameRemembered).not.toHaveBeenCalled();
  });
});

describe('usePresenter audience count', () => {
  beforeEach(() => {
    signedMock.mockReset();
    signedMock.mockImplementation(async (_s: unknown, fn: string, init: RequestInit = {}) => {
      if (fn === 'admin-storm' && !init.method) return { ...stormData('ABCDEFGH'), usage: { audience: 3 } };
      return { ok: true };
    });
  });

  it('starts from the loaded count and follows each announcement of a new device', async () => {
    const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
    expect(store.audience.value).toBeNull();
    await store.load();
    expect(store.audience.value).toBe(3);
    store.onAudience({ audience: 4 });
    expect(store.audience.value).toBe(4);
  });

  it('ignores a malformed announcement and forgets the count when the Storm changes', async () => {
    const store = usePresenter(ref({ stormCode: 'ABCDEFGH', secret: 's' }));
    await store.load();
    store.onAudience({ audience: 'many' } as never);
    expect(store.audience.value).toBe(3);
    store.reset();
    expect(store.audience.value).toBeNull();
  });
});
