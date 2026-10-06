import { computed, ref, type Ref } from 'vue';
import { api, ApiError } from '@/api';
import { copyText } from '@/composables/useClipboard';
import type { AdminQuestion, AdminStorm, AdminStormData, LicenseSummary, QuestionPayload, Tally, VisibleTally } from '@/shared/types';

export interface PresenterOptions {
  confirm?: (message: string) => boolean;
}

const message = (e: unknown) => (e as Error)?.message || 'Something went wrong';

export function usePresenter(adminKey: Ref<string>, options: PresenterOptions = {}) {
  const confirmFn = options.confirm ?? ((m: string) => window.confirm(m));

  const storm = ref<AdminStorm | null>(null);
  const questions = ref<AdminQuestion[]>([]);
  const showConnect = ref(false);
  const resultsBackground = ref<string | null>(null);
  const resultsKey = ref<string | null>(null);
  const license = ref<LicenseSummary | null>(null);
  const error = ref<string | null>(null);
  const copiedQuestion = ref<number | null>(null);

  const enc = () => encodeURIComponent(adminKey.value);
  const patchStorm = (body: Record<string, unknown>) =>
    api('admin-storm', { method: 'PATCH', body: JSON.stringify({ adminKey: adminKey.value, ...body }) });
  const patchQuestion = (body: Record<string, unknown>) =>
    api('admin-questions', { method: 'PATCH', body: JSON.stringify({ adminKey: adminKey.value, ...body }) });

  async function load() {
    const data = await api<AdminStormData>(`admin-storm?adminKey=${enc()}`);
    storm.value = data.storm;
    questions.value = data.questions;
    showConnect.value = !!data.showConnect;
    resultsBackground.value = data.resultsBackground ?? null;
    resultsKey.value = data.resultsKey;
    license.value = data.license ?? null;
  }

  async function safeLoad() {
    try {
      await load();
      error.value = null;
    } catch (e) {
      error.value = message(e);
    }
  }

  /** Runs an action, then refreshes; any failure is shown as the page error. Returns whether it succeeded. */
  async function act(fn: () => Promise<unknown>, reload = true): Promise<boolean> {
    try {
      await fn();
      if (reload) await load();
      error.value = null;
      return true;
    } catch (e) {
      error.value = message(e);
      return false;
    }
  }

  function onTally(data: Tally & { questionId: number }) {
    const q = questions.value.find((x) => x.id === data.questionId);
    if (!q) return;
    if ('hidden' in data) {
      void safeLoad();
      return;
    }
    q.tally = data as VisibleTally;
  }

  const currentQ = computed(() => questions.value.find((q) => q.id === storm.value?.current_question_id) ?? null);
  const currentIndex = computed(() => questions.value.findIndex((q) => q.id === storm.value?.current_question_id));

  function canStep(dir: number): boolean {
    const i = currentIndex.value;
    if (i === -1) return dir > 0 && questions.value.length > 0;
    return i + dir >= 0 && i + dir < questions.value.length;
  }

  const activate = (questionId: number) => act(() => patchStorm({ status: 'active', currentQuestionId: questionId }));

  async function stepQuestion(dir: number) {
    if (!canStep(dir)) return;
    const i = currentIndex.value;
    await activate(questions.value[i === -1 ? 0 : i + dir].id);
  }

  async function swap(i: number, j: number) {
    const a = questions.value[i];
    const b = questions.value[j];
    if (!a || !b) return;
    await act(async () => {
      await patchQuestion({ questionId: a.id, orderIndex: b.order_index });
      await patchQuestion({ questionId: b.id, orderIndex: a.order_index });
    });
  }

  async function saveQuestion(payload: QuestionPayload, editingId: number | null): Promise<boolean> {
    return act(async () => {
      if (editingId === null) {
        await api('admin-questions', { method: 'POST', body: JSON.stringify({ adminKey: adminKey.value, ...payload }) });
        return;
      }
      const send = (clearVotes: boolean) => patchQuestion({ questionId: editingId, edit: { ...payload, clearVotes } });
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
    return act(() => api('admin-storm', { method: 'DELETE', body: JSON.stringify({ adminKey: adminKey.value }) }), false);
  }

  async function setConnect(show: boolean) {
    if (await act(() => patchStorm({ showConnect: show }), false)) showConnect.value = show;
  }

  async function setResultsBackground(color: string | null) {
    if (await act(() => patchStorm({ resultsBackground: color }), false)) resultsBackground.value = color;
  }

  const questionLink = (q: AdminQuestion) => `${window.location.origin}/results/${resultsKey.value}?q=${q.id}`;

  async function copyQuestionLink(q: AdminQuestion) {
    const url = questionLink(q);
    if (await copyText(url)) {
      copiedQuestion.value = q.id;
      error.value = null;
      setTimeout(() => {
        if (copiedQuestion.value === q.id) copiedQuestion.value = null;
      }, 1500);
    } else {
      error.value = `Could not copy automatically. Use: ${url}`;
    }
  }

  return {
    storm, questions, showConnect, resultsBackground, resultsKey, license, error, copiedQuestion,
    currentQ, currentIndex,
    load, safeLoad, onTally, canStep, stepQuestion, activate, swap, saveQuestion, deleteStorm, setConnect, setResultsBackground, copyQuestionLink, questionLink,
    setQuestionFlag: (flags: Record<string, unknown>) => act(() => patchStorm(flags)),
    resetQuestion: (questionId: number) => act(() => patchQuestion({ questionId, action: 'reset' })),
    resetStorm: () => act(() => patchStorm({ action: 'reset' })),
    closeStorm: () => act(() => patchStorm({ status: 'closed' })),
    reopenStorm: () => act(() => patchStorm({ status: storm.value?.current_question_id ? 'active' : 'lobby' })),
    deleteQuestion: (questionId: number) =>
      act(() => api('admin-questions', { method: 'DELETE', body: JSON.stringify({ adminKey: adminKey.value, questionId }) })),
  };
}

export type PresenterStore = ReturnType<typeof usePresenter>;
