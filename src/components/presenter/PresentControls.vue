<script setup lang="ts">
import { computed } from 'vue';
import BrandMark from '@/components/BrandMark.vue';
import PresentStatus from '@/components/presenter/PresentStatus.vue';
import { firstLine, phaseText, presentStatus } from '@/lib/presenter';
import type { PresenterStore } from '@/composables/usePresenter';
import type { VotingPhase } from '@/composables/useVotingClock';
import type { AdminCloud } from '@/shared/types';

const props = defineProps<{
  store: PresenterStore;
  cloud: AdminCloud | null;
  phase: VotingPhase;
  label: string;
  showTitle: boolean;
  stormName: string;
  armed: boolean;
  fullscreen: { supported: boolean; active: boolean };
  /** True inside the phone sheet: shows Close instead of Hide controls. */
  sheet?: boolean;
}>();
defineEmits<{ edit: []; exit: []; fullscreen: []; dock: []; close: [] }>();

const TIMERS = [
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 120, label: '2m' },
  { seconds: 300, label: '5m' },
];
const KEYS: [string, string][] = [
  ['← →', 'previous, next'],
  ['T', 'arm the timer'],
  ['1', 'to 5 start 15s, 30s, 1m, 2m, 5m'],
  ['H', 'hide or show results'],
  ['J', 'join screen'],
  ['E', 'edit this cloud'],
  ['F', 'full screen'],
  ['D', 'hide the controls'],
  ['Esc', 'close the editor, then leave'],
];

const text = computed(() => phaseText(props.cloud?.kind ?? 'choice'));
const isContent = computed(() => props.cloud?.kind === 'content');
const index = computed(() => props.store.currentIndex.value);
const total = computed(() => props.store.clouds.value.length);
const liveId = computed(() => props.store.storm.value?.current_cloud_id ?? null);
const lines = computed(() =>
  presentStatus({ cloud: props.cloud, phase: props.phase, label: props.label, showConnect: props.store.showConnect.value }).filter((l) => l.key !== 'live'),
);
</script>

<template>
  <div class="present-controls">
    <div v-if="showTitle" class="present-title">
      <strong>{{ stormName }}</strong>
      <span class="logo-tile"><BrandMark /></span>
    </div>

    <div class="present-count-row">
      <strong v-if="cloud && index >= 0">Cloud {{ index + 1 }} of {{ total }}</strong>
      <strong v-else class="muted">No cloud is live</strong>
      <span v-if="cloud" class="badge active"><span class="dot pulse"></span>Live</span>
    </div>
    <PresentStatus :lines="lines" />

    <div class="present-grid2">
      <button class="btn edit-cloud" :disabled="!cloud" @click="$emit('edit')">Edit cloud</button>
      <button class="btn" @click="$emit('exit')">Exit</button>
      <button v-if="fullscreen.supported" class="btn" @click="$emit('fullscreen')">{{ fullscreen.active ? 'Exit full screen' : 'Full screen' }}</button>
      <button v-if="sheet" class="btn" @click="$emit('close')">Close</button>
      <button v-else class="btn" @click="$emit('dock')">Hide controls</button>
    </div>

    <div class="present-grid2 present-step">
      <button class="btn lg" :disabled="!store.canStep(-1)" @click="store.stepCloud(-1)">&lsaquo; Previous</button>
      <button class="btn primary lg" :disabled="!store.canStep(1)" @click="store.stepCloud(1)">Next &rsaquo;</button>
    </div>

    <template v-if="cloud">
      <h2>Timer</h2>
      <div class="timer-chips-row" :class="{ armed }" role="group" aria-label="Start a timer">
        <button v-for="t in TIMERS" :key="t.seconds" class="btn sm" @click="store.startTimer(cloud, t.seconds)">{{ t.label }}</button>
      </div>
      <p v-if="armed" class="present-hint">Press 1 to 5</p>
      <!-- Only while there is something to show: an empty grid would still add a gap under the chips. -->
      <div v-if="phase === 'running' || (isContent && phase === 'closed')" class="present-grid2">
        <template v-if="isContent">
          <button v-if="phase === 'running'" class="btn sm" @click="store.addTime(cloud, 30)">+30s</button>
          <button class="btn sm" :class="{ primary: phase === 'closed' }" @click="store.clearTimer(cloud)">{{ text.unlock }}</button>
        </template>
        <template v-else>
          <button v-if="phase === 'running'" class="btn sm" @click="store.addTime(cloud, 30)">+30s</button>
          <button v-if="phase === 'running'" class="btn sm" @click="store.lockVoting(cloud, false)">Cancel timer</button>
        </template>
      </div>
    </template>

    <h2>Audience sees</h2>
    <div class="present-grid2">
      <template v-if="cloud && !isContent">
        <button class="btn sm" @click="store.setCloudFlag({ cloudId: cloud.id, resultsHidden: !cloud.results_hidden })">
          {{ cloud.results_hidden ? 'Show results' : 'Hide results' }}
        </button>
        <button v-if="cloud.correct" class="btn sm" @click="store.setCloudFlag({ cloudId: cloud.id, answerShown: !cloud.answer_shown })">
          {{ cloud.answer_shown ? 'Hide answer' : 'Reveal answer' }}
        </button>
      </template>
      <button class="btn sm" @click="store.setConnect(!store.showConnect.value)">{{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}</button>
      <template v-if="cloud && !isContent">
        <button v-if="phase === 'running'" class="btn sm" @click="store.lockVoting(cloud, true)">Lock now</button>
        <button v-else-if="phase === 'closed'" class="btn sm primary" @click="store.lockVoting(cloud, false)">{{ text.unlock }}</button>
        <button v-else class="btn sm" @click="store.lockVoting(cloud, true)">{{ text.lock }}</button>
      </template>
    </div>

    <details class="present-keys">
      <summary>Keyboard shortcuts</summary>
      <ul>
        <li v-for="[key, what] in KEYS" :key="key"><kbd>{{ key }}</kbd> {{ what }}</li>
      </ul>
    </details>

    <nav v-if="total" class="cloud-list" aria-label="Clouds">
      <h2>Clouds</h2>
      <div v-for="(item, i) in store.clouds.value" :key="item.id" class="li" :class="{ live: item.id === liveId }">
        <span class="li-num">{{ i + 1 }}</span>
        <span class="li-text" :title="firstLine(item.body)">{{ firstLine(item.body) }}</span>
        <span class="li-count muted">{{ item.kind === 'content' ? '' : item.tally.totalVotes || 0 }}</span>
        <span class="li-actions">
          <!-- In the narrow rail Copy link is an icon (its words stay for screen readers) so each cloud fits on one line. -->
          <button v-if="item.kind !== 'content'" class="btn sm copy-link" title="Copy link: the results screen for this cloud. Opening it makes the cloud live." @click="store.copyCloudLink(item)">
            <svg class="copy-icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path v-if="store.copiedCloud.value === item.id" d="M3 8.5l3 3 7-7" />
              <template v-else><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" /></template>
            </svg>
            <span class="copy-label">{{ store.copiedCloud.value === item.id ? 'Copied!' : 'Copy link' }}</span>
          </button>
          <button v-if="item.id !== liveId" class="btn sm primary" @click="store.activate(item.id)">Go live</button>
          <span v-else class="badge active">Live</span>
        </span>
      </div>
    </nav>
  </div>
</template>

<style>
.rail .present-controls, .sheet .present-controls { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.present-title { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.present-title strong { font-size: 1rem; line-height: 1.25; overflow-wrap: anywhere; }
.present-title .logo-tile { display: inline-flex; align-items: center; gap: 6px; font-size: .75rem; color: var(--text-muted); }
.present-title .logo { width: 20px; height: 20px; border-radius: 6px; }
.present-title .logo svg { width: 13px; height: 13px; }
.present-count-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.present-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.present-controls .btn { justify-content: center; }
/* Two equal columns in a 280px rail leave about 120px a button: the default side padding would wrap or widen them. */
.present-grid2 .btn { padding-left: 6px; padding-right: 6px; }
.present-step .btn { min-height: 52px; font-size: 1.05rem; white-space: nowrap; padding-left: 8px; padding-right: 8px; }
.present-controls h2 { margin: 6px 0 0; font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
.present-hint { margin: 0; font-size: .82rem; font-weight: 700; color: var(--accent); }
.timer-chips-row { display: flex; flex-wrap: wrap; gap: 6px; }
.timer-chips-row.armed { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
.present-keys { font-size: .82rem; color: var(--text-muted); }
.present-keys summary { cursor: pointer; }
.present-keys ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; }
.present-keys kbd { font: inherit; font-weight: 700; padding: 0 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2); color: var(--text); }
.cloud-list { border-top: 1px solid var(--border); min-height: 0; }
.cloud-list h2 { margin: 10px 0 4px; }
.cloud-list .li { display: flex; align-items: center; gap: 8px; padding: 7px 2px; border-bottom: 1px solid var(--border); font-size: .85rem; }
.cloud-list .li.live { font-weight: 700; }
.cloud-list .li-num { flex: none; min-width: 1.6em; text-align: center; font-size: .72rem; font-weight: 700; padding: 1px 4px; border-radius: 6px; background: var(--surface-2); color: var(--text-muted); }
.cloud-list .li.live .li-num { background: var(--accent); color: var(--accent-contrast); }
.cloud-list .li-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cloud-list .li-count { flex: none; font-variant-numeric: tabular-nums; }
.cloud-list .li-actions { flex: none; display: flex; align-items: center; gap: 6px; }
.cloud-list .copy-icon { display: none; }
/* The rail is narrow: one line per cloud, so many more fit before the list scrolls. Copy link shrinks to its icon and Go live
   to a compact button; the text keeps the rest and ends in an ellipsis (its full text is in the tooltip). */
.rail .cloud-list .li { gap: 6px; padding: 5px 0; }
.rail .cloud-list .li-actions { gap: 4px; }
.rail .cloud-list .li-actions .btn { padding: 3px 7px; font-size: .74rem; min-height: 26px; }
.rail .cloud-list .copy-icon { display: block; }
.rail .cloud-list .copy-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.rail .cloud-list .li-actions .badge { font-size: .7rem; }
</style>
