<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type * as Ably from 'ably';
import { api, ApiError } from '@/api';
import { subscribeRoom } from '@/composables/useRoomChannel';
import { normalizeTally, responsesLabel } from '@/lib/tally';
import type { ClosedQuestion, Question, RoomState, Tally } from '@/shared/types';
import QrCode from '@/components/QrCode.vue';
import BrandMark from '@/components/BrandMark.vue';
import QuestionResults from '@/components/QuestionResults.vue';
import ResultsCarousel from '@/components/ResultsCarousel.vue';

const route = useRoute();
const resultsKey = computed(() => String(route.params.resultsKey ?? ''));
const lockedId = computed(() => {
  const q = route.query.q;
  const value = Array.isArray(q) ? q[0] : q;
  return value && /^\d+$/.test(value) ? Number(value) : null;
});

const roomCode = ref<string | null>(null);
const currentQuestion = ref<Question | null>(null);
const tally = ref<Tally>(normalizeTally(null));
const slides = ref<ClosedQuestion[] | null>(null);
const roomClosed = ref(false);
const showConnect = ref(false);
const connected = ref(false);
const connectedCount = ref(0);
const loadError = ref<string | null>(null);
const loading = ref(true);
const lockedReady = ref(false);
let ably: Ably.Realtime | null = null;

const voteUrl = computed(() => `${window.location.origin}/vote/${encodeURIComponent(roomCode.value ?? '')}`);
const voteUrlLabel = computed(() => voteUrl.value.replace(/^https?:\/\//, ''));
const total = computed(() => tally.value.totalVotes || 0);
const showResponseCount = computed(
  () => !roomClosed.value && !currentQuestion.value?.resultsHidden && !(lockedId.value && !currentQuestion.value),
);

function failWith(err: unknown) {
  loadError.value = (err as Error)?.message || 'Something went wrong';
}

async function loadClosedResults() {
  const data = await api<{ questions: ClosedQuestion[] }>(`get-room-results?roomCode=${encodeURIComponent(roomCode.value ?? '')}`);
  slides.value = data.questions;
}

// A results link pinned to one question makes that question live (never reopening a closed room).
async function activateLocked() {
  try {
    await api('results-activate', { method: 'POST', body: JSON.stringify({ resultsKey: resultsKey.value, questionId: lockedId.value }) });
  } catch {
    /* viewing still works if activation fails */
  }
}

async function loadLocked() {
  const data = await api<{ question: Question | null; tally: Tally | null }>(
    `get-question-results?roomCode=${encodeURIComponent(roomCode.value ?? '')}&questionId=${lockedId.value}`,
  );
  currentQuestion.value = data.question;
  lockedReady.value = true;
  tally.value = normalizeTally(data.tally);
  roomClosed.value = false;
  showConnect.value = false;
}

function onState(data: { status: string; currentQuestion: Question | null; initialTally: Tally | null; showConnect: boolean }) {
  if (lockedId.value) {
    loadLocked().catch(failWith);
    return;
  }
  currentQuestion.value = data.currentQuestion;
  tally.value = normalizeTally(data.initialTally);
  roomClosed.value = data.status === 'closed';
  showConnect.value = !!data.showConnect;
  if (roomClosed.value) loadClosedResults().catch(failWith);
}

onMounted(async () => {
  if (!resultsKey.value) {
    loadError.value = 'No room specified.';
    loading.value = false;
    return;
  }
  try {
    const resolved = await api<{ roomCode: string }>(`resolve-results-key?key=${encodeURIComponent(resultsKey.value)}`);
    roomCode.value = resolved.roomCode;
  } catch (err) {
    loading.value = false;
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Results not found.' : (err as Error)?.message || 'Something went wrong';
    return;
  }

  try {
    if (lockedId.value) {
      await activateLocked();
      await loadLocked();
    } else {
      const state = await api<RoomState>(`get-room-state?roomCode=${encodeURIComponent(roomCode.value)}`);
      currentQuestion.value = state.currentQuestion;
      tally.value = normalizeTally(state.tally);
      roomClosed.value = state.status === 'closed';
      showConnect.value = !!state.showConnect;
      if (roomClosed.value) await loadClosedResults();
    }
  } catch (err) {
    loading.value = false;
    failWith(err);
    return;
  }

  loading.value = false;
  ably = subscribeRoom(
    roomCode.value,
    {
      state: onState,
      tally: (data: Tally & { questionId: number }) => {
        if (currentQuestion.value && data.questionId === currentQuestion.value.id) tally.value = normalizeTally(data);
      },
    },
    { onPresence: (count) => (connectedCount.value = count) },
  );
  connected.value = ably.connection.state === 'connected';
  ably.connection.on((change) => (connected.value = change.current === 'connected'));
});

onBeforeUnmount(() => ably?.close());
</script>

<template>
  <div class="results-page">
    <div class="topbar">
      <span class="brand">
        <BrandMark />
      </span>
      <span v-if="!roomClosed" class="badge" :class="connected ? 'active' : 'lobby'">
        <span class="dot" :class="{ pulse: connected }"></span>
        <span>{{ connected ? 'Live' : 'Connecting\u2026' }}</span>
      </span>
    </div>

    <main class="results-main">
      <div v-if="loadError" class="alert error">{{ loadError }}</div>

      <div v-else-if="loading" class="results-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>Loading&hellip;</span>
      </div>

      <ResultsCarousel v-else-if="roomCode && roomClosed && slides" :slides="slides" large :show-nav="false" />

      <div v-else-if="lockedId && lockedReady && !currentQuestion" class="not-active" role="status">This question isn&rsquo;t active right now</div>

      <div v-else-if="currentQuestion && !roomClosed">
        <h1 class="prompt">{{ currentQuestion.prompt }}</h1>
        <QuestionResults :question="currentQuestion" :tally="tally" projector />
      </div>
    </main>

    <div v-show="showConnect && !loadError" class="connect-screen">
      <div class="waiting">
        <QrCode class="join-qr" :value="voteUrl" label="QR code linking to the voting page" />
        <h1 class="join-title">Scan to vote</h1>
        <p class="url">{{ voteUrlLabel }}</p>
        <span class="badge accent">
          <span class="dot" :class="{ pulse: connectedCount > 0 }"></span>
          <span>{{ connectedCount }} {{ connectedCount === 1 ? 'person' : 'people' }} connected</span>
        </span>
      </div>
      <p class="attribution">
        Copyright&nbsp;<a href="https://codepenguin.com" title="David Lambert (Code Penguin)">David&nbsp;Lambert&nbsp;(Code&nbsp;Penguin)</a>
      </p>
    </div>

    <footer class="footer">
      <div class="footer-info">
        <span v-if="showResponseCount"><strong>{{ total }}</strong> {{ responsesLabel(total) }}</span>
        <span v-if="roomClosed">Swipe or use the arrow keys to browse questions</span>
        <span v-if="roomCode">Room {{ roomCode }}</span>
      </div>
      <p class="attribution">
        Copyright&nbsp;<a href="https://codepenguin.com" title="David Lambert (Code Penguin)">David&nbsp;Lambert&nbsp;(Code&nbsp;Penguin)</a>
      </p>
    </footer>
  </div>
</template>

<style>
.results-page { flex: 1; display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; }
.results-page .topbar { display: flex; align-items: center; justify-content: space-between; padding: clamp(10px, 2.4vh, 20px) 40px; }
.results-main { flex: 1; display: flex; flex-direction: column; justify-content: center; width: 100%; max-width: 1400px; margin: 0 auto; padding: 0 48px clamp(8px, 2vh, 32px); }
.results-page .prompt { font-size: clamp(1.6rem, min(4.5vw, 7vh), 4rem); font-weight: 800; margin-bottom: clamp(14px, 3.6vh, 44px); }
.results-loading { display: flex; align-items: center; justify-content: center; gap: 14px; color: var(--text-muted); font-size: 1.2rem; }
.results-loading .spinner { width: 24px; height: 24px; }
.results-page .not-active { text-align: center; color: var(--text-muted); font-weight: 700; font-size: clamp(1.6rem, 4vw, 3rem); padding: 64px 0; }
.results-page .waiting { text-align: center; }
.results-page .waiting h1 { font-size: clamp(1.8rem, 4vw, 2.8rem); margin-bottom: 8px; }
.results-page .waiting .join-title { margin-top: 22px; }
.results-page .join-qr { width: clamp(200px, 22vh, 340px); margin: 0 auto; }
.results-page .waiting .url { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: clamp(1rem, 1.6vw, 1.5rem); color: var(--text-muted); overflow-wrap: anywhere; }
.results-page .waiting .badge { font-size: clamp(.95rem, 1.4vw, 1.25rem); padding: 6px 16px; margin-top: 22px; }
.connect-screen { position: fixed; inset: 0; z-index: 40; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 24px; overflow-y: auto; }
.connect-screen .attribution { position: absolute; left: 0; right: 0; bottom: 16px; }
.results-page .footer { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 18px 40px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 1rem; }
.results-page .footer-info { display: flex; gap: 24px; align-items: center; }
.results-page .footer strong { color: var(--text); font-size: 1.15rem; }
@media (max-width: 720px) {
  .results-page .topbar, .results-page .footer { padding: 14px 16px; }
  .results-page .join-qr { width: 180px; }
  .results-main { padding: 0 16px 16px; }
}
</style>
