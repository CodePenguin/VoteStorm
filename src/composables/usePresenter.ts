import { computed, ref, type Ref } from 'vue';
import { ApiError } from '@/api';
import { copyText } from '@/composables/useClipboard';
import { describeSecret, generateAdminSecret } from '@/lib/adminKeys';
import { signedApi, type AdminSession } from '@/lib/adminRequest';
import { resultsUrl } from '@/lib/fragment';
import { renameRemembered } from '@/lib/recentStorms';
import type { AdminCloud, AdminStorm, AdminStormData, LicenseSummary, CloudPayload, Tally, VisibleTally } from '@/shared/types';

export interface PresenterOptions {
  confirm?: (message: string) => boolean;
}

const message = (e: unknown) => (e as Error)?.message || 'Something went wrong';

export function usePresenter(session: Ref<AdminSession>, options: PresenterOptions = {}) {
  const confirmFn = options.confirm ?? ((m: string) => window.confirm(m));

  const storm = ref<AdminStorm | null>(null);
  const clouds = ref<AdminCloud[]>([]);
  const showConnect = ref(false);
  const resultsBackground = ref<string | null>(null);
  const resultsKey = ref<string | null>(null);
  const license = ref<LicenseSummary | null>(null);
  const error = ref<string | null>(null);
  const copiedCloud = ref<number | null>(null);

  // Every admin call is signed with the secret; the secret itself is never sent. The function name is signed as given, so it is passed bare.
  const signed = <T = unknown>(fn: string, init: RequestInit = {}) => signedApi<T>(session.value, fn, init);
  const patchStorm = (body: Record<string, unknown>) => signed('admin-storm', { method: 'PATCH', body: JSON.stringify(body) });
  const patchCloud = (body: Record<string, unknown>) => signed('admin-clouds', { method: 'PATCH', body: JSON.stringify(body) });

  // Bumped by reset(), so a load that was started for the previous Storm cannot write its answer over the new one.
  let generation = 0;

  async function load() {
    const started = generation;
    const secret = session.value.secret;
    const data = await signed<AdminStormData>('admin-storm');
    const key = (await describeSecret(secret)).resultsKey;
    if (started !== generation) return;
    storm.value = data.storm;
    clouds.value = data.clouds;
    showConnect.value = !!data.showConnect;
    resultsBackground.value = data.resultsBackground ?? null;
    resultsKey.value = key;
    license.value = data.license ?? null;
  }

  /** Forgets everything shown, for when the link now points at a different Storm (or none). */
  function reset() {
    generation++;
    storm.value = null;
    clouds.value = [];
    showConnect.value = false;
    resultsBackground.value = null;
    resultsKey.value = null;
    license.value = null;
    error.value = null;
    copiedCloud.value = null;
  }

  async function safeLoad() {
    const started = generation;
    try {
      await load();
      if (started === generation) error.value = null;
    } catch (e) {
      if (started === generation) error.value = message(e);
    }
  }

  /**
   * Runs an action, then refreshes; any failure is shown as the page error. Returns whether it succeeded. If the page
   * has moved to another Storm while the action ran, nothing is shown or changed for it and this returns false.
   */
  async function act(fn: () => Promise<unknown>, reload = true): Promise<boolean> {
    const started = generation;
    try {
      await fn();
      if (started !== generation) return false;
      if (reload) await load();
      if (started !== generation) return false;
      error.value = null;
      return true;
    } catch (e) {
      if (started !== generation) return false;
      error.value = message(e);
      return false;
    }
  }

  function onTally(data: Tally & { cloudId: number }) {
    const q = clouds.value.find((x) => x.id === data.cloudId);
    if (!q) return;
    if ('hidden' in data) {
      void safeLoad();
      return;
    }
    q.tally = data as VisibleTally;
  }

  const currentQ = computed(() => clouds.value.find((q) => q.id === storm.value?.current_cloud_id) ?? null);
  const currentIndex = computed(() => clouds.value.findIndex((q) => q.id === storm.value?.current_cloud_id));

  function canStep(dir: number): boolean {
    const i = currentIndex.value;
    if (i === -1) return dir > 0 && clouds.value.length > 0;
    return i + dir >= 0 && i + dir < clouds.value.length;
  }

  const activate = (cloudId: number) => act(() => patchStorm({ status: 'active', currentCloudId: cloudId }));

  async function stepCloud(dir: number) {
    if (!canStep(dir)) return;
    const i = currentIndex.value;
    await activate(clouds.value[i === -1 ? 0 : i + dir].id);
  }

  async function swap(i: number, j: number) {
    const a = clouds.value[i];
    const b = clouds.value[j];
    if (!a || !b) return;
    await act(async () => {
      await patchCloud({ cloudId: a.id, orderIndex: b.order_index });
      await patchCloud({ cloudId: b.id, orderIndex: a.order_index });
    });
  }

  async function saveCloud(payload: CloudPayload, editingId: number | null): Promise<boolean> {
    return act(async () => {
      if (editingId === null) {
        await signed('admin-clouds', { method: 'POST', body: JSON.stringify(payload) });
        return;
      }
      const send = (clearVotes: boolean) => patchCloud({ cloudId: editingId, edit: { ...payload, clearVotes } });
      try {
        await send(false);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && confirmFn(`${e.message} Continue?`)) await send(true);
        else throw e;
      }
    });
  }

  async function deleteStorm(): Promise<boolean> {
    if (!confirmFn('Delete this Storm? This cannot be undone.')) return false;
    return act(() => signed('admin-storm', { method: 'DELETE' }), false);
  }

  /** Copies this Storm's clouds into a new Storm with its own new secret. Returns the copy's session, or null (with the error shown). */
  async function duplicateStorm(): Promise<AdminSession | null> {
    try {
      const made = await generateAdminSecret();
      const data = await signed<{ stormCode: string }>('duplicate-storm', { method: 'POST', body: JSON.stringify({ publicKey: made.publicKey, resultsKeyHash: made.resultsKeyHash }) });
      error.value = null;
      return { stormCode: data.stormCode, secret: made.secret };
    } catch (e) {
      error.value = message(e);
      return null;
    }
  }

  /** Names the Storm (empty clears the name). The list of recent Storms on this device follows. */
  async function setName(name: string) {
    const clean = name.trim();
    if (await act(() => patchStorm({ name: clean }), false)) {
      if (storm.value) storm.value.name = clean || null;
      renameRemembered(session.value.stormCode, clean || null);
    }
  }

  async function setConnect(show: boolean) {
    if (await act(() => patchStorm({ showConnect: show }), false)) showConnect.value = show;
  }

  async function setResultsBackground(color: string | null) {
    if (await act(() => patchStorm({ resultsBackground: color }), false)) resultsBackground.value = color;
  }

  /** `words` is only a marker so the activity notice speaks of submissions for a word cloud; the server ignores it. */
  const lockVoting = (q: AdminCloud, locked: boolean) =>
    act(() => patchStorm({ cloudId: q.id, votingLocked: locked, ...(q.kind === 'words' ? { words: true } : {}) }));
  /** Clears a content cloud's timer. `clearTimer` is only a marker for the activity notice; the server ignores it. */
  const clearTimer = (q: AdminCloud) => act(() => patchStorm({ cloudId: q.id, votingLocked: false, clearTimer: true }));
  const startTimer = (q: AdminCloud, seconds: number) => act(() => patchStorm({ cloudId: q.id, votingSeconds: seconds }));
  const addTime = (q: AdminCloud, seconds: number) => act(() => patchStorm({ cloudId: q.id, votingAddSeconds: seconds }));

  const hideWord = (c: AdminCloud, word: string) => act(() => patchCloud({ cloudId: c.id, hideWord: word }));
  const showWord = (c: AdminCloud, word: string) => act(() => patchCloud({ cloudId: c.id, showWord: word }));

  const cloudLink = (q: AdminCloud) => resultsUrl(window.location.origin, resultsKey.value ?? '', q.id);

  async function copyCloudLink(q: AdminCloud) {
    const url = cloudLink(q);
    if (await copyText(url)) {
      copiedCloud.value = q.id;
      error.value = null;
      setTimeout(() => {
        if (copiedCloud.value === q.id) copiedCloud.value = null;
      }, 1500);
    } else {
      error.value = `Could not copy automatically. Use: ${url}`;
    }
  }

  return {
    storm, clouds, showConnect, resultsBackground, resultsKey, license, error, copiedCloud,
    currentQ, currentIndex,
    load, reset, safeLoad, onTally, canStep, stepCloud, activate, swap, saveCloud, deleteStorm, duplicateStorm, setName, setConnect, setResultsBackground, lockVoting, clearTimer, startTimer, addTime, hideWord, showWord, copyCloudLink, cloudLink,
    setCloudFlag: (flags: Record<string, unknown>) => act(() => patchStorm(flags)),
    resetCloud: (cloudId: number) => act(() => patchCloud({ cloudId, action: 'reset' })),
    resetStorm: () => act(() => patchStorm({ action: 'reset' })),
    closeStorm: () => act(() => patchStorm({ status: 'closed' })),
    reopenStorm: () => act(() => patchStorm({ status: storm.value?.current_cloud_id ? 'active' : 'lobby' })),
    deleteCloud: (cloudId: number) =>
      act(() => signed('admin-clouds', { method: 'DELETE', body: JSON.stringify({ cloudId }) })),
  };
}

export type PresenterStore = ReturnType<typeof usePresenter>;
