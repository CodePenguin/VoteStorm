<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type * as Ably from 'ably';
import { api, ApiError, getDeviceId } from '@/api';
import { subscribeStorm } from '@/composables/useStormChannel';
import { useVotingClock } from '@/composables/useVotingClock';
import { plainLine } from '@/lib/markdown';
import { normalizeStormCode } from '@/lib/stormCode';
import { normalizeTally, ratingValues } from '@/lib/tally';
import type { ClosedCloud, Cloud, StormState, Tally } from '@/shared/types';
import BrandMark from '@/components/BrandMark.vue';
import CloudResults from '@/components/CloudResults.vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import ResultsCarousel from '@/components/ResultsCarousel.vue';
import ShareModal from '@/components/ShareModal.vue';
import WordsInput from '@/components/WordsInput.vue';

const route = useRoute();
const stormCode = computed(() => normalizeStormCode(String(route.params.stormCode ?? '')));
const deviceId = getDeviceId();

const currentCloud = ref<Cloud | null>(null);
const clock = useVotingClock(() => currentCloud.value?.votingMsLeft);
const votingClosed = computed(() => clock.phase.value === 'closed');
// Read out by screen readers whenever it changes, because the page swaps whole sections rather than editing text in place.
const announcement = computed(() => {
  if (loading.value) return '';
  if (stormClosed.value) return 'This Storm has ended';
  const q = currentCloud.value;
  if (!q) return 'Waiting for the next cloud';
  if (votingClosed.value) return closedLabel.value;
  if (hasVoted.value) return isWords.value ? 'Your words are in' : 'Your vote is in';
  if (q.kind === 'content') return 'New cloud';
  return `New cloud: ${plainLine(q.body).slice(0, 80)}`;
});
const isWords = computed(() => currentCloud.value?.kind === 'words');
const closedLabel = computed(() => {
  const kind = currentCloud.value?.kind;
  return kind === 'content' ? "Time's up" : kind === 'words' ? 'Submissions closed' : 'Voting closed';
});
const showingCloud = computed(() => !!currentCloud.value && !!stormCode.value && !loading.value && !loadError.value && !stormClosed.value);
// A closed question or word cloud says so in its card heading, so the sticky chip would only repeat it. A content cloud
// has no such card (it keeps showing its body), so its chip stays.
const showChip = computed(() => showingCloud.value && clock.phase.value !== 'open' && !(votingClosed.value && currentCloud.value?.kind !== 'content'));
const heading = ref<HTMLElement | null>(null);
const tally = ref<Tally>(normalizeTally(null));
const stormClosed = ref(false);
const slides = ref<ClosedCloud[] | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);
const hasVoted = ref(false);
const myVote = ref<number | number[] | string[] | null>(null);
const picks = ref<number[]>([]);
const submitting = ref(false);
const voteError = ref<string | null>(null);
const showShare = ref(false);
let ably: Ably.Realtime | null = null;

const voteUrl = computed(() => `${window.location.origin}/vote/${encodeURIComponent(stormCode.value)}`);
const options = computed(() => currentCloud.value?.options ?? []);
const correctLabel = computed(() => {
  const q = currentCloud.value;
  return (q?.correct ?? []).map((i) => q?.options?.[i]).filter(Boolean).join(', ');
});

const myWords = computed(() => (isWords.value && Array.isArray(myVote.value) ? (myVote.value as unknown[]).filter((w): w is string => typeof w === 'string') : []));

// Per Storm, because cloud ids restart from 1 in every Storm.
const votedKey = (id: number) => `votestorm_voted_${stormCode.value}_${id}`;
const voteKey = (id: number) => `votestorm_vote_${stormCode.value}_${id}`;

function storedVote(id: number): number | number[] | string[] | null {
  try {
    return JSON.parse(localStorage.getItem(voteKey(id)) ?? 'null');
  } catch {
    return null;
  }
}

function applyState(cloud: Cloud | null) {
  const same = !!cloud && !!currentCloud.value && cloud.id === currentCloud.value.id;
  currentCloud.value = cloud;
  if (same) return;
  if (cloud) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    nextTick(() => heading.value?.focus());
  }
  picks.value = [];
  voteError.value = null;
  hasVoted.value = cloud ? !!localStorage.getItem(votedKey(cloud.id)) : false;
  myVote.value = cloud ? storedVote(cloud.id) : null;
}

async function loadClosedResults() {
  const data = await api<{ clouds: ClosedCloud[] }>(`get-storm-results?stormCode=${encodeURIComponent(stormCode.value)}`);
  slides.value = data.clouds;
}

function failWith(err: unknown) {
  loadError.value = (err as Error)?.message || 'Something went wrong';
}

function onState(data: { status: string; currentCloud: Cloud | null; initialTally: Tally | null }) {
  stormClosed.value = data.status === 'closed';
  applyState(data.currentCloud);
  tally.value = normalizeTally(data.initialTally);
  if (stormClosed.value) loadClosedResults().catch(failWith);
}

function onReset(data: { cloudId?: number }) {
  if (data.cloudId) {
    localStorage.removeItem(votedKey(data.cloudId));
    localStorage.removeItem(voteKey(data.cloudId));
    if (currentCloud.value?.id === data.cloudId) {
      hasVoted.value = false;
      myVote.value = null;
      picks.value = [];
    }
  } else {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`votestorm_voted_${stormCode.value}_`) || key.startsWith(`votestorm_vote_${stormCode.value}_`)) localStorage.removeItem(key);
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
  picks.value = Array.isArray(myVote.value) && !isWords.value ? [...(myVote.value as number[])] : [];
  hasVoted.value = false;
}

async function vote(value: number | number[]) {
  const q = currentCloud.value;
  if (!q || submitting.value) return;
  submitting.value = true;
  voteError.value = null;
  try {
    await api('vote', {
      method: 'POST',
      body: JSON.stringify({ stormCode: stormCode.value, cloudId: q.id, deviceId, value }),
    });
    localStorage.setItem(votedKey(q.id), '1');
    localStorage.setItem(voteKey(q.id), JSON.stringify(value));
    myVote.value = value;
    hasVoted.value = true;
  } catch (err) {
    if ((err as { code?: string }).code === 'voting_closed') clock.markClosed();
    voteError.value = (err as Error)?.message || 'Could not submit your vote. Please try again.';
  } finally {
    submitting.value = false;
  }
}

async function sendWords(list: string[]) {
  const q = currentCloud.value;
  if (!q || submitting.value) return;
  submitting.value = true;
  voteError.value = null;
  try {
    const res = await api<{ ok: boolean; tally?: Tally; words?: string[] }>('vote', {
      method: 'POST',
      body: JSON.stringify({ stormCode: stormCode.value, cloudId: q.id, deviceId, value: list }),
    });
    const kept = Array.isArray(res?.words) ? res.words : list;
    if (res?.tally) tally.value = normalizeTally(res.tally);
    localStorage.setItem(votedKey(q.id), '1');
    localStorage.setItem(voteKey(q.id), JSON.stringify(kept));
    myVote.value = kept;
    hasVoted.value = true;
  } catch (err) {
    if ((err as { code?: string }).code === 'voting_closed') clock.markClosed();
    voteError.value = (err as Error)?.message || 'Could not send your words. Please try again.';
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  // Older versions kept one key per cloud id, shared by every Storm; those would make a new Storm's cloud look voted.
  for (const key of Object.keys(localStorage)) {
    if (/^votestorm_(voted|vote)_\d+$/.test(key)) localStorage.removeItem(key);
  }
  if (!stormCode.value) {
    loading.value = false;
    return;
  }
  try {
    const state = await api<StormState>(`get-storm-state?stormCode=${encodeURIComponent(stormCode.value)}`);
    stormClosed.value = state.status === 'closed';
    applyState(state.currentCloud);
    tally.value = normalizeTally(state.tally);
    if (stormClosed.value) await loadClosedResults();
  } catch (err) {
    loading.value = false;
    loadError.value = err instanceof ApiError && err.status === 404 ? "We couldn't find that Storm." : (err as Error)?.message || 'Something went wrong';
    return;
  }
  loading.value = false;
  ably = subscribeStorm(
    stormCode.value,
    {
      state: onState,
      tally: (data: Tally & { cloudId: number }) => {
        if (currentCloud.value && data.cloudId === currentCloud.value.id) tally.value = normalizeTally(data);
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
        <button v-if="stormCode" class="icon-btn" aria-label="Share this poll with a QR code" title="Share with a QR code" @click="showShare = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" /></svg>
        </button>
      </div>
    </header>

    <ShareModal v-if="showShare" :url="voteUrl" @close="showShare = false" />

    <p class="sr-only" role="status">{{ announcement }}</p>
    <main class="container narrow vote-main">
      <h1 v-if="showingCloud" ref="heading" class="sr-only" tabindex="-1">Current cloud</h1>
      <p v-if="showChip" class="voting-clock sticky-timer" role="timer">{{ clock.phase.value === 'running' ? `${clock.label.value} left` : closedLabel }}</p>

      <div v-if="!stormCode" class="card state">
        <div class="icon closed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg></div>
        <h1>No Storm specified</h1>
        <p>Check the link you were given and try again.</p>
      </div>

      <div v-else-if="loadError" class="alert error">{{ loadError }}</div>

      <div v-else-if="loading" class="card state loading-state" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p>Loading&hellip;</p>
      </div>

      <ResultsCarousel v-else-if="stormClosed && slides" :slides="slides" />

      <div v-else-if="!stormClosed && !currentCloud" class="card state">
        <div class="icon"><svg class="pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></div>
        <h1>Waiting for the next cloud</h1>
        <p>This page updates automatically &mdash; no need to refresh.</p>
      </div>

      <div v-else-if="currentCloud && currentCloud.kind !== 'content' && (hasVoted || votingClosed)">
        <div class="card state">
          <div v-if="hasVoted" class="icon ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
          <div v-else class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg></div>
          <h2>{{ votingClosed ? closedLabel : isWords ? 'Thanks, your words are in' : 'Thanks, your vote is in' }}</h2>
          <p v-if="votingClosed" class="muted">{{ hasVoted ? (isWords ? 'Your words are in.' : 'Your vote is in.') : isWords ? 'This cloud is no longer taking words.' : 'This cloud is no longer taking votes.' }}</p>
          <p v-if="currentCloud.correct" class="correct-note"><strong>Correct answer:</strong> {{ correctLabel }}</p>
          <button v-if="hasVoted && !votingClosed" class="btn" style="margin-top: 16px" @click="changeVote">{{ isWords ? 'Change my words' : 'Change my vote' }}</button>
        </div>
        <div class="card slide-card" style="margin-top: 16px; min-height: 0">
          <div class="slide-eyebrow">{{ currentCloud.resultsHidden ? 'Responses' : 'Live results' }}</div>
          <div class="prompt"><MarkdownContent :source="currentCloud.body" /></div>
          <CloudResults :cloud="currentCloud" :tally="tally" />
        </div>
      </div>

      <div v-else-if="currentCloud && currentCloud.kind === 'content'" class="card content-card">
        <div class="prompt"><MarkdownContent :source="currentCloud.body" /></div>
      </div>

      <div v-else-if="currentCloud">
        <div class="prompt"><MarkdownContent :source="currentCloud.body" /></div>
        <div v-if="voteError" class="alert error" style="margin-bottom: 16px">{{ voteError }}</div>
        <p v-if="currentCloud.correct" class="correct-note" style="margin-bottom: 12px"><strong>Correct answer:</strong> {{ correctLabel }}</p>

        <div v-if="currentCloud.kind === 'choice' && !currentCloud.multi" class="choices">
          <button v-for="(opt, i) in options" :key="i" class="choice" :class="{ picked: myVote === i }" :aria-pressed="myVote === i" :disabled="submitting" @click="vote(i)">{{ opt }}</button>
        </div>

        <div v-else-if="currentCloud.kind === 'choice'" class="choices">
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

        <WordsInput v-else-if="currentCloud.kind === 'words'" :key="currentCloud.id" :max="currentCloud.maxWords ?? 3" :initial="myWords" :busy="submitting" @send="sendWords" />

        <div v-else>
          <p class="hint">Pick a number from {{ currentCloud.scaleMin }} to {{ currentCloud.scaleMax }}</p>
          <div class="rating-grid">
            <button v-for="n in ratingValues(currentCloud)" :key="n" class="rate" :class="{ picked: myVote === n }" :aria-pressed="myVote === n" :disabled="submitting" @click="vote(n)">{{ n }}</button>
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
.voting-clock { display: inline-block; margin-bottom: 12px; padding: 4px 14px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
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
.loading-state { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.loading-state .spinner { width: 28px; height: 28px; }
.state .icon { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 16px; background: var(--accent-soft); color: var(--accent); }
.state .icon svg { width: 28px; height: 28px; }
.state .icon.ok { background: var(--success-soft); color: var(--success); }
.state .icon.closed { background: var(--surface-2); color: var(--text-muted); }
.state h1, .state h2 { font-size: 1.3rem; margin-bottom: 6px; }
.state p { color: var(--text-muted); }
</style>
