<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type * as Ably from 'ably';
import { api, ApiError } from '@/api';
import { subscribeStorm } from '@/composables/useStormChannel';
import { normalizeTally, responsesLabel } from '@/lib/tally';
import { resultsTheme } from '@/lib/color';
import { readFragment } from '@/lib/fragment';
import { formatStormCode } from '@/lib/stormCode';
import { useVotingClock } from '@/composables/useVotingClock';
import { useFitText } from '@/composables/useFitText';
import type { ClosedCloud, Cloud, StormState, Tally } from '@/shared/types';
import QrCode from '@/components/QrCode.vue';
import BrandMark from '@/components/BrandMark.vue';
import CloudResults from '@/components/CloudResults.vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import ResultsCarousel from '@/components/ResultsCarousel.vue';

const route = useRoute();
// The key and the pinned cloud live after the `#`, which a browser never sends to a server.
const fragment = computed(() => readFragment(route.hash));
const resultsKey = computed(() => fragment.value.get('k') ?? '');
const lockedId = computed(() => {
  const value = fragment.value.get('c');
  return value && /^\d+$/.test(value) ? Number(value) : null;
});

const stormCode = ref<string | null>(null);
const currentCloud = ref<Cloud | null>(null);
const clock = useVotingClock(() => currentCloud.value?.votingMsLeft);
const tally = ref<Tally>(normalizeTally(null));
const slides = ref<ClosedCloud[] | null>(null);
const stormClosed = ref(false);
const showConnect = ref(false);
const background = ref<string | null>(null);
const theme = computed(() => resultsTheme(background.value));
const connected = ref(false);
const connectedCount = ref(0);
const loadError = ref<string | null>(null);
const loading = ref(true);
const lockedReady = ref(false);
let ably: Ably.Realtime | null = null;

const voteUrl = computed(() => `${window.location.origin}/vote/${encodeURIComponent(stormCode.value ?? '')}`);
const voteUrlLabel = computed(() => voteUrl.value.replace(/^https?:\/\//, ''));
const total = computed(() => tally.value.totalVotes || 0);
const kind = computed(() => currentCloud.value?.kind);
const showResponseCount = computed(
  () => !stormClosed.value && !currentCloud.value?.resultsHidden && !(lockedId.value && !currentCloud.value) && kind.value !== 'content',
);
const closedText = computed(() => (kind.value === 'content' ? "Time's up" : kind.value === 'words' ? 'Submissions closed' : 'Voting closed'));

// The cloud body and results shrink to fit the screen; below the minimum scale the box scrolls instead.
const fitBox = ref<HTMLElement | null>(null);
const fitInner = ref<HTMLElement | null>(null);
// A word cloud's height falls with the square of the scale, so it can shrink further than text before the box has to scroll.
useFitText(fitBox, fitInner, () => [currentCloud.value?.id, currentCloud.value?.body, tally.value], { min: () => (kind.value === 'words' ? 0.2 : 0.45) });

function failWith(err: unknown) {
  loadError.value = (err as Error)?.message || 'Something went wrong';
}

async function loadClosedResults() {
  const data = await api<{ clouds: ClosedCloud[] }>(`get-storm-results?stormCode=${encodeURIComponent(stormCode.value ?? '')}`);
  slides.value = data.clouds;
}

// A results link pinned to one cloud makes that cloud live (never reopening a closed storm).
async function activateLocked() {
  try {
    await api('results-activate', { method: 'POST', body: JSON.stringify({ resultsKey: resultsKey.value, cloudId: lockedId.value }) });
  } catch {
    /* viewing still works if activation fails */
  }
}

async function loadLocked() {
  const data = await api<{ cloud: Cloud | null; tally: Tally | null }>(
    `get-cloud-results?stormCode=${encodeURIComponent(stormCode.value ?? '')}&cloudId=${lockedId.value}`,
  );
  currentCloud.value = data.cloud;
  lockedReady.value = true;
  tally.value = normalizeTally(data.tally);
  stormClosed.value = false;
  showConnect.value = false;
}

function onState(data: { status: string; currentCloud: Cloud | null; initialTally: Tally | null; showConnect: boolean; resultsBackground?: string | null }) {
  if (data.resultsBackground !== undefined) background.value = data.resultsBackground;
  if (lockedId.value) {
    loadLocked().catch(failWith);
    return;
  }
  currentCloud.value = data.currentCloud;
  tally.value = normalizeTally(data.initialTally);
  stormClosed.value = data.status === 'closed';
  showConnect.value = !!data.showConnect;
  if (stormClosed.value) loadClosedResults().catch(failWith);
}

onMounted(async () => {
  if (!resultsKey.value) {
    loadError.value = 'No Storm specified.';
    loading.value = false;
    return;
  }
  try {
    const resolved = await api<{ stormCode: string; resultsBackground: string | null }>(`resolve-results-key?key=${encodeURIComponent(resultsKey.value)}`);
    stormCode.value = resolved.stormCode;
    background.value = resolved.resultsBackground ?? null;
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
      const state = await api<StormState>(`get-storm-state?stormCode=${encodeURIComponent(stormCode.value)}`);
      currentCloud.value = state.currentCloud;
      tally.value = normalizeTally(state.tally);
      stormClosed.value = state.status === 'closed';
      showConnect.value = !!state.showConnect;
      if (stormClosed.value) await loadClosedResults();
    }
  } catch (err) {
    loading.value = false;
    failWith(err);
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
    },
    { onPresence: (count) => (connectedCount.value = count) },
  );
  connected.value = ably.connection.state === 'connected';
  ably.connection.on((change) => (connected.value = change.current === 'connected'));
});

onBeforeUnmount(() => ably?.close());
</script>

<template>
  <div class="results-page" :style="theme">
    <header class="topbar">
      <span class="brand">
        <BrandMark />
      </span>
      <span class="topbar-right">
        <span v-if="currentCloud && !stormClosed && clock.phase.value !== 'open'" class="voting-badge" :class="clock.phase.value" role="timer">
          {{ clock.phase.value === 'running' ? clock.label.value : closedText }}
        </span>
        <span v-if="!stormClosed" class="badge" :class="connected ? 'active' : 'lobby'">
          <span class="dot" :class="{ pulse: connected }"></span>
          <span>{{ connected ? 'Live' : 'Connecting\u2026' }}</span>
        </span>
      </span>
    </header>

    <main class="results-main">
      <div v-if="loadError" class="alert error">{{ loadError }}</div>

      <div v-else-if="loading" class="results-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>Loading&hellip;</span>
      </div>

      <ResultsCarousel v-else-if="stormCode && stormClosed && slides" :slides="slides" large :show-nav="false" />

      <div v-else-if="lockedId && lockedReady && !currentCloud" class="not-active" role="status">This cloud isn&rsquo;t active right now</div>

      <template v-else-if="currentCloud && !stormClosed">
        <h1 class="sr-only">Current cloud</h1>
        <div ref="fitBox" class="fit-box">
          <div ref="fitInner" class="fit-inner">
            <div class="prompt" :class="{ 'keep-readable': kind !== 'content' }"><MarkdownContent :source="currentCloud.body" large /></div>
            <CloudResults :cloud="currentCloud" :tally="tally" projector />
          </div>
        </div>
      </template>
    </main>

    <section v-show="showConnect && !loadError" class="connect-screen" aria-label="Join this Storm">
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
        Copyright&nbsp;<a href="https://codepenguin.com" rel="noopener noreferrer" title="David Lambert (Code Penguin)">David&nbsp;Lambert&nbsp;(Code&nbsp;Penguin)</a>
      </p>
    </section>

    <footer class="footer">
      <div class="footer-info">
        <span v-if="showResponseCount && kind === 'words'"><strong>{{ total }}</strong> {{ total === 1 ? 'person has' : 'people have' }} sent words</span>
        <span v-else-if="showResponseCount"><strong>{{ total }}</strong> {{ responsesLabel(total) }}</span>
        <span v-if="stormClosed">Swipe or use the arrow keys to browse clouds</span>
        <span v-if="stormCode">Storm code {{ formatStormCode(stormCode) }}</span>
      </div>
      <p class="attribution">
        Copyright&nbsp;<a href="https://codepenguin.com" rel="noopener noreferrer" title="David Lambert (Code Penguin)">David&nbsp;Lambert&nbsp;(Code&nbsp;Penguin)</a>
      </p>
    </footer>
  </div>
</template>

<style>
.results-page { flex: 1; display: flex; flex-direction: column; height: 100vh; height: 100dvh; max-height: 100vh; max-height: 100dvh; overflow: hidden; background: var(--bg); color: var(--text); }
.results-page .topbar { display: flex; align-items: center; justify-content: space-between; padding: clamp(10px, 2.4vh, 20px) 40px; }
.results-page .topbar-right { display: flex; align-items: center; gap: 16px; }
.results-page .voting-badge { font-size: clamp(1.1rem, 2.2vw, 1.9rem); font-weight: 800; font-variant-numeric: tabular-nums; padding: 2px 18px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.results-page .voting-badge.closed { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
.results-main { flex: 1; min-height: 0; display: flex; flex-direction: column; width: 100%; max-width: 1400px; margin: 0 auto; padding: 0 48px clamp(8px, 2vh, 32px); overflow-y: auto; }
.results-page .prompt { font-size: calc(var(--fit, 1) * clamp(1.6rem, min(4.5vw, 7vh), 4rem)); font-weight: 800; margin-bottom: calc(var(--fit, 1) * clamp(14px, 3.6vh, 44px)); }
/* A question above its results stays readable from across a room: only the results shrink below 0.6 of the scale. */
.results-page .prompt.keep-readable { font-size: calc(max(var(--fit, 1), 0.6) * clamp(1.6rem, min(4.5vw, 7vh), 4rem)); margin-bottom: calc(max(var(--fit, 1), 0.6) * clamp(14px, 3.6vh, 44px)); }
.results-page .prompt:not(.keep-readable) .md :is(p, li, td, th) { font-weight: 600; }
.results-page .prompt .md img { max-height: 60vh; object-fit: contain; }
/* The box fills the space between the top bar and the footer, whatever its content, so useFitText has a fixed height to fit to; the inner block is centred in it but stays reachable by scrolling. */
.results-page .fit-box { flex: 1 1 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.results-page .fit-inner { margin: auto 0; }
/* Centred with auto margins rather than justify-content, so a block taller than the space overflows downward and stays scrollable from its top. */
.results-main > :is(.carousel, .results-loading, .not-active, .alert) { margin: auto 0; }
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
