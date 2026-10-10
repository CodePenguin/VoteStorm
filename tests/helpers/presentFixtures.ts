import { computed, ref } from 'vue';
import { vi } from 'vitest';
import type { PresenterStore } from '@/composables/usePresenter';
import type { AdminCloud } from '@/shared/types';

let nextId = 1;
export function makeCloud(over: Partial<AdminCloud> = {}): AdminCloud {
  const id = over.id ?? nextId++;
  return {
    id, storm_code: 'ABCDEFGH', order_index: id, kind: 'choice', body: `Cloud ${id}`, options: JSON.stringify(['Red', 'Blue']),
    scale_min: null, scale_max: null, multi: 0, results_hidden: 0, answer_shown: 0, correct: null, display: 'bars', closes_at: null,
    voting_ms_left: null, max_words: null, hidden_words: null, tally: { counts: [3, 1], totalVotes: 4 },
    ...over,
  } as AdminCloud;
}

/** A stand-in for the presenter store: the same names, refs for state, and spies for every action. */
export function makeStore(over: { clouds?: AdminCloud[]; currentId?: number | null; showConnect?: boolean } = {}): PresenterStore {
  const clouds = ref(over.clouds ?? []);
  const storm = ref({ storm_code: 'ABCDEFGH', status: 'active', current_cloud_id: over.currentId ?? null, name: 'All-hands' });
  const done = () => vi.fn().mockResolvedValue(true);
  return {
    storm, clouds, showConnect: ref(over.showConnect ?? false), copiedCloud: ref<number | null>(null), error: ref<string | null>(null),
    resultsBackground: ref<string | null>(null), resultsKey: ref<string | null>(null), license: ref(null),
    currentQ: computed(() => clouds.value.find((c) => c.id === storm.value.current_cloud_id) ?? null),
    currentIndex: computed(() => clouds.value.findIndex((c) => c.id === storm.value.current_cloud_id)),
    canStep: vi.fn(() => true), stepCloud: done(), activate: done(), startTimer: done(), addTime: done(), clearTimer: done(), lockVoting: done(),
    setCloudFlag: done(), setConnect: done(), hideWord: done(), showWord: done(), copyCloudLink: done(),
    load: done(), safeLoad: done(), reset: vi.fn(), onTally: vi.fn(), swap: done(), saveCloud: done(), deleteStorm: done(), duplicateStorm: done(), setName: done(), setResultsBackground: done(),
    resetCloud: done(), resetStorm: done(), closeStorm: done(), reopenStorm: done(), deleteCloud: done(), cloudLink: vi.fn(() => 'https://example.test/vote/ABCDEFGH'),
  } as unknown as PresenterStore;
}
