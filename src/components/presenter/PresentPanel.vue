<script setup lang="ts">
import { computed, ref } from 'vue';
import CloudResults from '@/components/CloudResults.vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import WordModeration from '@/components/presenter/WordModeration.vue';
import { firstLine, phaseText, toPrivateCloud } from '@/lib/presenter';
import { responsesLabel } from '@/lib/tally';
import { useVotingClock } from '@/composables/useVotingClock';
import type { PresenterStore } from '@/composables/usePresenter';
import { useOverflows } from '@/composables/useOverflows';

const props = defineProps<{ store: PresenterStore }>();

const q = computed(() => props.store.currentQ.value);
const clock = useVotingClock(() => q.value?.voting_ms_left);
const TIMERS = [
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 120, label: '2m' },
  { seconds: 300, label: '5m' },
];
const isContent = computed(() => q.value?.kind === 'content');
const phase = computed(() => phaseText(q.value?.kind ?? 'choice'));
const total = computed(() => q.value?.tally.totalVotes || 0);
const preview = ref<HTMLElement | null>(null);
const previewClipped = useOverflows(preview);
</script>

<template>
  <div class="present">
    <div class="card present-now">
      <div class="card-title">Now showing</div>
      <template v-if="q">
        <h2 class="sr-only">Current cloud</h2>
        <div class="present-prompt"><MarkdownContent :source="q.body" /></div>
        <p v-if="!isContent" class="muted" style="margin: 6px 0 16px"><strong class="present-count">{{ total }}</strong> {{ responsesLabel(total) }}</p>
        <div class="toolbar" style="margin: 16px 0">
          <button v-if="!isContent" class="btn" @click="store.setCloudFlag({ cloudId: q.id, resultsHidden: !q.results_hidden })">
            {{ q.results_hidden ? 'Show results' : 'Hide results' }}
          </button>
          <button v-if="!isContent && q.correct" class="btn" @click="store.setCloudFlag({ cloudId: q.id, answerShown: !q.answer_shown })">
            {{ q.answer_shown ? 'Hide answer' : 'Reveal answer' }}
          </button>
          <button class="btn" @click="store.setConnect(!store.showConnect.value)">{{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}</button>
        </div>
        <div class="voting-row">
          <span class="voting-state" :class="clock.phase.value" role="timer">
            <template v-if="clock.phase.value === 'running'">{{ clock.label.value }} left</template>
            <template v-else-if="clock.phase.value === 'closed'">{{ phase.closed }}</template>
            <template v-else>{{ phase.open }}</template>
          </span>
          <template v-if="isContent">
            <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.addTime(q, 30)">+30s</button>
            <button v-if="clock.phase.value !== 'open'" class="btn sm" :class="{ primary: clock.phase.value === 'closed' }" @click="store.clearTimer(q)">{{ phase.unlock }}</button>
          </template>
          <template v-else>
            <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.lockVoting(q, true)">Lock now</button>
            <button v-else-if="clock.phase.value === 'closed'" class="btn sm primary" @click="store.lockVoting(q, false)">{{ phase.unlock }}</button>
            <button v-else class="btn sm" @click="store.lockVoting(q, true)">{{ phase.lock }}</button>
            <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.addTime(q, 30)">+30s</button>
            <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.lockVoting(q, false)">Cancel timer</button>
          </template>
          <span class="timer-chips" role="group" aria-label="Start a timer">
            <span class="muted">Timer</span>
            <button v-for="t in TIMERS" :key="t.seconds" class="btn sm" @click="store.startTimer(q, t.seconds)">{{ t.label }}</button>
          </span>
        </div>
        <div v-if="!isContent" class="q-results">
          <p v-if="q.results_hidden" class="muted" style="font-size: .85rem; margin-bottom: 8px">Results are hidden from the audience. You can still see them here.</p>
          <WordModeration v-if="q.kind === 'words'" :cloud="q" :store="store" />
          <div ref="preview" :class="{ 'word-preview': q.kind === 'words', overflowing: q.kind === 'words' && previewClipped }"><CloudResults :cloud="toPrivateCloud(q)" :tally="q.tally" hide-total /></div>
        </div>
      </template>
      <template v-else>
        <h2 class="present-prompt muted">No cloud is live</h2>
        <div class="toolbar" style="margin-top: 12px">
          <button class="btn" @click="store.setConnect(!store.showConnect.value)">{{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}</button>
        </div>
      </template>
    </div>

    <div class="present-nav">
      <button class="btn lg" :disabled="!store.canStep(-1)" @click="store.stepCloud(-1)">&lsaquo; Previous</button>
      <button class="btn primary lg" :disabled="!store.canStep(1)" @click="store.stepCloud(1)">Next &rsaquo;</button>
    </div>

    <div v-if="store.clouds.value.length" class="card">
      <div v-for="(item, index) in store.clouds.value" :key="item.id" class="present-row" :class="{ live: item.id === store.storm.value?.current_cloud_id }">
        <span class="q-num">{{ index + 1 }}</span>
        <span class="present-row-prompt">{{ firstLine(item.body) }}</span>
        <span class="muted present-row-count">{{ item.kind === 'content' ? '' : item.tally.totalVotes || 0 }}</span>
        <button v-if="item.kind !== 'content'" class="btn sm" title="Results screen for this cloud. Opening it makes the cloud live." @click="store.copyCloudLink(item)">
          {{ store.copiedCloud.value === item.id ? 'Copied!' : 'Copy link' }}
        </button>
        <button v-if="item.id !== store.storm.value?.current_cloud_id" class="btn sm primary" @click="store.activate(item.id)">Go live</button>
        <span v-else class="badge active"><span class="dot pulse"></span>Live</span>
      </div>
    </div>
  </div>
</template>

<style>
.present { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.present-prompt { max-height: 45vh; overflow: auto; }
/* The presenter's own word cloud is only a preview; moderation sits above it so removing a word never needs a scroll. */
.present-now .word-preview { max-height: 40vh; overflow: hidden; margin-top: 16px; }
.present-now .word-preview.overflowing { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 3em), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 3em), transparent); }
/* A one-paragraph body (a question) is bold like a heading; a longer content body is bold only in its headings. */
.present-prompt { font-size: clamp(1.4rem, 4vw, 2rem); font-weight: 400; line-height: 1.25; min-width: 0; }
.present-prompt .md { line-height: 1.25; }
.present-prompt .md > p:only-child { font-weight: 700; }
.present-prompt .md :is(h2, h3, h4, h5, h6) { font-size: inherit; font-weight: 700; margin: 0 0 .4em; }
.present-prompt .md img { max-height: 40vh; object-fit: contain; }
.present-count { font-size: 1.6rem; color: var(--accent); }
.present-nav { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.present-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--border); }
.present-row:last-child { border-bottom: 0; }
.present-row.live .present-row-prompt { font-weight: 700; }
.present-row-prompt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voting-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.voting-state { font-weight: 700; font-variant-numeric: tabular-nums; padding: 4px 12px; border-radius: 999px; background: var(--surface-2); color: var(--text-muted); }
.voting-state.running { background: var(--accent-soft); color: var(--accent); }
.voting-state.closed { background: var(--warn-soft); color: var(--warn); }
.timer-chips { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.present-row-count { font-variant-numeric: tabular-nums; min-width: 2ch; text-align: right; }
</style>
