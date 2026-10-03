<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type * as Ably from 'ably';
import { api, ApiError, getDeviceId } from '@/api';
import { subscribeRoom } from '@/composables/useRoomChannel';
import { normalizeTally, ratingValues } from '@/lib/tally';
import type { ClosedQuestion, Question, RoomState, Tally } from '@/shared/types';
import BrandMark from '@/components/BrandMark.vue';
import QuestionResults from '@/components/QuestionResults.vue';
import ResultsCarousel from '@/components/ResultsCarousel.vue';
import ShareModal from '@/components/ShareModal.vue';

const route = useRoute();
const roomCode = computed(() => String(route.params.roomCode ?? ''));
const deviceId = getDeviceId();

const currentQuestion = ref<Question | null>(null);
const tally = ref<Tally>(normalizeTally(null));
const roomClosed = ref(false);
const slides = ref<ClosedQuestion[] | null>(null);
const loadError = ref<string | null>(null);
const hasVoted = ref(false);
const myVote = ref<number | number[] | null>(null);
const picks = ref<number[]>([]);
const submitting = ref(false);
const voteError = ref<string | null>(null);
const showShare = ref(false);
let ably: Ably.Realtime | null = null;

const voteUrl = computed(() => `${window.location.origin}/vote/${encodeURIComponent(roomCode.value)}`);
const options = computed(() => currentQuestion.value?.options ?? []);
const correctLabel = computed(() => {
  const q = currentQuestion.value;
  return (q?.correct ?? []).map((i) => q?.options?.[i]).filter(Boolean).join(', ');
});

const votedKey = (id: number) => `votestorm_voted_${id}`;
const voteKey = (id: number) => `votestorm_vote_${id}`;

function storedVote(id: number): number | number[] | null {
  try {
    return JSON.parse(localStorage.getItem(voteKey(id)) ?? 'null');
  } catch {
    return null;
  }
}

function applyState(question: Question | null) {
  const same = !!question && !!currentQuestion.value && question.id === currentQuestion.value.id;
  currentQuestion.value = question;
  if (same) return;
  picks.value = [];
  voteError.value = null;
  hasVoted.value = question ? !!localStorage.getItem(votedKey(question.id)) : false;
  myVote.value = question ? storedVote(question.id) : null;
}

async function loadClosedResults() {
  const data = await api<{ questions: ClosedQuestion[] }>(`get-room-results?roomCode=${encodeURIComponent(roomCode.value)}`);
  slides.value = data.questions;
}

function failWith(err: unknown) {
  loadError.value = (err as Error)?.message || 'Something went wrong';
}

function onState(data: { status: string; currentQuestion: Question | null; initialTally: Tally | null }) {
  roomClosed.value = data.status === 'closed';
  applyState(data.currentQuestion);
  tally.value = normalizeTally(data.initialTally);
  if (roomClosed.value) loadClosedResults().catch(failWith);
}

function onReset(data: { questionId?: number }) {
  if (data.questionId) {
    localStorage.removeItem(votedKey(data.questionId));
    localStorage.removeItem(voteKey(data.questionId));
    if (currentQuestion.value?.id === data.questionId) {
      hasVoted.value = false;
      myVote.value = null;
      picks.value = [];
    }
  } else {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('votestorm_voted_') || key.startsWith('votestorm_vote_')) localStorage.removeItem(key);
    }
    hasVoted.value = false;
    myVote.value = null;
    picks.value = [];
  }
}

function togglePick(i: number) {
  picks.value = picks.value.includes(i) ? picks.value.filter((n) => n !== i) : [...picks.value, i];
}

function changeVote() {
  picks.value = Array.isArray(myVote.value) ? [...myVote.value] : [];
  hasVoted.value = false;
}

async function vote(value: number | number[]) {
  const q = currentQuestion.value;
  if (!q || submitting.value) return;
  submitting.value = true;
  voteError.value = null;
  try {
    await api('vote', {
      method: 'POST',
      body: JSON.stringify({ roomCode: roomCode.value, questionId: q.id, deviceId, value }),
    });
    localStorage.setItem(votedKey(q.id), '1');
    localStorage.setItem(voteKey(q.id), JSON.stringify(value));
    myVote.value = value;
    hasVoted.value = true;
  } catch (err) {
    voteError.value = (err as Error)?.message || 'Could not submit your vote. Please try again.';
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  if (!roomCode.value) return;
  try {
    const state = await api<RoomState>(`get-room-state?roomCode=${encodeURIComponent(roomCode.value)}`);
    roomClosed.value = state.status === 'closed';
    applyState(state.currentQuestion);
    tally.value = normalizeTally(state.tally);
    if (roomClosed.value) await loadClosedResults();
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? "We couldn't find that room." : (err as Error)?.message || 'Something went wrong';
    return;
  }
  ably = subscribeRoom(
    roomCode.value,
    {
      state: onState,
      tally: (data: Tally & { questionId: number }) => {
        if (currentQuestion.value && data.questionId === currentQuestion.value.id) tally.value = normalizeTally(data);
      },
      reset: onReset,
    },
    { clientId: deviceId },
  );
});

onBeforeUnmount(() => ably?.close());
</script>

<template>
  <div class="vote-page">
    <header class="app-header">
      <div class="container narrow">
        <span class="brand">
          <BrandMark />
        </span>
        <span class="spacer"></span>
        <button v-if="roomCode" class="icon-btn" aria-label="Share this poll with a QR code" title="Share with a QR code" @click="showShare = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" /></svg>
        </button>
      </div>
    </header>

    <ShareModal v-if="showShare" :url="voteUrl" @close="showShare = false" />

    <main class="container narrow vote-main">
      <div v-if="!roomCode" class="card state">
        <div class="icon closed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg></div>
        <h2>No room specified</h2>
        <p>Check the link you were given and try again.</p>
      </div>

      <div v-else-if="loadError" class="alert error">{{ loadError }}</div>

      <ResultsCarousel v-else-if="roomClosed && slides" :slides="slides" />

      <div v-else-if="!roomClosed && !currentQuestion" class="card state">
        <div class="icon"><svg class="pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></div>
        <h2>Waiting for the next question</h2>
        <p>This page updates automatically &mdash; no need to refresh.</p>
      </div>

      <div v-else-if="currentQuestion && hasVoted">
        <div class="card state">
          <div class="icon ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
          <h2>Thanks, your vote is in</h2>
          <p v-if="currentQuestion.correct" class="correct-note"><strong>Correct answer:</strong> {{ correctLabel }}</p>
          <button class="btn" style="margin-top: 16px" @click="changeVote">Change my vote</button>
        </div>
        <div class="card slide-card" style="margin-top: 16px; min-height: 0">
          <div class="slide-eyebrow">Live results</div>
          <h2 class="slide-title">{{ currentQuestion.prompt }}</h2>
          <QuestionResults :question="currentQuestion" :tally="tally" />
        </div>
      </div>

      <div v-else-if="currentQuestion">
        <h1 class="prompt">{{ currentQuestion.prompt }}</h1>
        <div v-if="voteError" class="alert error" style="margin-bottom: 16px">{{ voteError }}</div>
        <p v-if="currentQuestion.correct" class="correct-note" style="margin-bottom: 12px"><strong>Correct answer:</strong> {{ correctLabel }}</p>

        <div v-if="currentQuestion.type === 'choice' && !currentQuestion.multi" class="choices">
          <button v-for="(opt, i) in options" :key="i" class="choice" :class="{ picked: myVote === i }" :disabled="submitting" @click="vote(i)">{{ opt }}</button>
        </div>

        <div v-else-if="currentQuestion.type === 'choice'" class="choices">
          <p class="hint" style="margin-bottom: 0">Select all that apply</p>
          <button
            v-for="(opt, i) in options" :key="i" class="choice" :class="{ picked: picks.includes(i) }"
            :aria-pressed="picks.includes(i)" :disabled="submitting" @click="togglePick(i)"
          >
            <span class="tick" aria-hidden="true">{{ picks.includes(i) ? '\u2713' : '' }}</span>
            <span>{{ opt }}</span>
          </button>
          <button class="btn primary lg" :disabled="submitting || picks.length === 0" @click="vote(picks.slice().sort((a, b) => a - b))">Submit</button>
        </div>

        <div v-else>
          <p class="hint">Pick a number from {{ currentQuestion.scaleMin }} to {{ currentQuestion.scaleMax }}</p>
          <div class="rating-grid">
            <button v-for="n in ratingValues(currentQuestion)" :key="n" class="rate" :class="{ picked: myVote === n }" :disabled="submitting" @click="vote(n)">{{ n }}</button>
          </div>
        </div>
      </div>
    </main>

  </div>
</template>

<style>
.vote-page { display: flex; flex-direction: column; }
.vote-main { flex: 1; padding-top: 28px; padding-bottom: 24px; }
.vote-page .prompt { font-size: clamp(1.4rem, 5.5vw, 1.8rem); margin-bottom: 20px; }
.vote-page .hint { color: var(--text-muted); font-size: .9rem; margin-bottom: 16px; }
.choices { display: grid; gap: 12px; }
.choice {
  width: 100%; text-align: left; padding: 16px 18px; min-height: 58px; display: flex; align-items: center; gap: 12px;
  font: inherit; font-size: 1.08rem; font-weight: 600; color: var(--text);
  background: var(--surface); border: 2px solid var(--border); border-radius: var(--radius);
  cursor: pointer; transition: border-color .15s, background .15s, transform .05s;
}
.choice:hover { border-color: var(--accent); background: var(--accent-soft); }
.choice:active { transform: scale(.99); }
.choice.picked { border-color: var(--accent); background: var(--accent-soft); }
.choice .tick { width: 22px; height: 22px; flex: none; border: 2px solid var(--border); border-radius: 6px; display: inline-grid; place-items: center; font-size: .9rem; color: var(--accent-contrast); }
.choice.picked .tick { background: var(--accent); border-color: var(--accent); }
.choice:not([aria-pressed]) .tick { display: none; }
.rating-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: 10px; }
.rate {
  aspect-ratio: 1; min-height: 56px; font: inherit; font-size: 1.25rem; font-weight: 700; color: var(--text);
  background: var(--surface); border: 2px solid var(--border); border-radius: var(--radius);
  cursor: pointer; transition: border-color .15s, background .15s, transform .05s;
}
.rate:hover, .rate.picked { border-color: var(--accent); background: var(--accent-soft); }
.rate:active { transform: scale(.96); }
.correct-note { color: var(--success); background: var(--success-soft); border-radius: var(--radius-sm); padding: 8px 12px; display: inline-block; }
.state { text-align: center; padding: 40px 20px; }
.state .icon { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 16px; background: var(--accent-soft); color: var(--accent); }
.state .icon svg { width: 28px; height: 28px; }
.state .icon.ok { background: var(--success-soft); color: var(--success); }
.state .icon.closed { background: var(--surface-2); color: var(--text-muted); }
.state h2 { font-size: 1.3rem; margin-bottom: 6px; }
.state p { color: var(--text-muted); }
</style>
