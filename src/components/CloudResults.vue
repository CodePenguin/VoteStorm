<script setup lang="ts">
import { computed } from 'vue';
import type { Cloud, Tally } from '@/shared/types';
import {
  DONUT_COLORS, countFor, donutSegments, formatAverage, hasCounts, isHiddenTally, isLeader, pctFor, ratingValues, responsesLabel, wordsOf,
} from '@/lib/tally';
import WordCloud from '@/components/WordCloud.vue';

const props = defineProps<{ cloud: Cloud; tally: Tally; large?: boolean; projector?: boolean; hideTotal?: boolean }>();

const total = computed(() => props.tally.totalVotes || 0);
const hidden = computed(() => props.cloud.resultsHidden || isHiddenTally(props.tally));
// A donut already shows the total in its centre, and some screens show it elsewhere.
const showTotal = computed(() => !hidden.value && !props.hideTotal && props.cloud.kind !== 'content' && props.cloud.kind !== 'words' && !(props.cloud.kind === 'choice' && props.cloud.display === 'donut'));
const visible = computed(() => (hasCounts(props.tally) ? props.tally : { counts: [] as number[], totalVotes: total.value }));
const options = computed(() => props.cloud.options ?? []);
const isCorrect = (i: number) => (props.cloud.correct ?? []).includes(i);
const segments = computed(() => donutSegments(options.value.map((_, i) => countFor(visible.value, i))));
const donutLabel = computed(() => {
  const parts = options.value.map((opt, i) => `${opt}: ${countFor(visible.value, i)} (${pctFor(visible.value, i)}%)`);
  return `Donut chart of responses. ${parts.join(', ')}`;
});
const average = computed(() => ('average' in visible.value ? visible.value.average : null));
</script>

<template>
  <div class="results-view" :class="{ large: large || projector, projector, rating: cloud.kind === 'rating' }">
    <div v-if="hidden" class="hidden-results">
      <div class="big-count">{{ total }}</div>
      <p>{{ total === 1 ? 'response received' : 'responses received' }}</p>
    </div>

    <template v-else-if="cloud.kind === 'words'">
      <WordCloud :words="wordsOf(tally)" :large="large || projector" />
      <p v-if="!hideTotal" class="slide-total">{{ total }} {{ total === 1 ? 'person has' : 'people have' }} sent words</p>
    </template>

    <template v-else-if="cloud.kind === 'content'"></template>

    <template v-else-if="cloud.kind === 'choice' && cloud.display === 'donut'">
      <div class="donut-wrap">
        <div class="donut" role="img" :aria-label="donutLabel">
          <svg viewBox="0 0 42 42">
            <circle class="donut-ring" cx="21" cy="21" r="15.915" />
            <circle
              v-for="(seg, i) in segments" :key="i" class="donut-seg" cx="21" cy="21" r="15.915"
              :stroke="DONUT_COLORS[i % DONUT_COLORS.length]" :stroke-dasharray="`${seg.dash} ${100 - seg.dash}`" :stroke-dashoffset="seg.offset"
            />
          </svg>
          <div class="donut-center"><strong>{{ total }}</strong><span>{{ responsesLabel(total) }}</span></div>
        </div>
        <ul class="donut-legend">
          <li v-for="(opt, i) in options" :key="i" :class="{ correct: isCorrect(i) }">
            <span class="swatch" :style="{ background: DONUT_COLORS[i % DONUT_COLORS.length] }"></span>
            <span>{{ opt }}{{ isCorrect(i) ? ' \u2713' : '' }}</span>
            <span class="num">{{ countFor(visible, i) }}<small>{{ pctFor(visible, i) }}%</small></span>
          </li>
        </ul>
      </div>
    </template>

    <template v-else-if="cloud.kind === 'choice'">
      <div v-for="(opt, i) in options" :key="i" class="sbar" :class="{ leader: isLeader(visible, i), correct: isCorrect(i) }">
        <div class="sbar-head">
          <span class="label">{{ opt }}</span>
          <span class="count">{{ countFor(visible, i) }}<small>{{ pctFor(visible, i) }}%</small></span>
        </div>
        <div class="sbar-track"><div class="sbar-fill" :style="{ width: pctFor(visible, i) + '%' }"></div></div>
      </div>
    </template>

    <template v-else>
      <div v-for="v in ratingValues(cloud)" :key="v" class="sbar" :class="{ leader: isLeader(visible, v) }">
        <div class="sbar-head">
          <span class="label">{{ v }}</span>
          <span class="count">{{ countFor(visible, v) }}</span>
        </div>
        <div class="sbar-track"><div class="sbar-fill" :style="{ width: pctFor(visible, v) + '%' }"></div></div>
      </div>
      <div class="slide-average">
        <strong>{{ formatAverage(average) }}</strong>
        <span class="muted">average rating</span>
      </div>
    </template>

    <p v-if="showTotal" class="slide-total">{{ total }} {{ responsesLabel(total) }}</p>
  </div>
</template>

<style>
.hidden-results { text-align: center; padding: 32px 0; color: var(--text-muted); }
.hidden-results .big-count { font-size: 3.5rem; font-weight: 800; line-height: 1; color: var(--accent); font-variant-numeric: tabular-nums; margin-bottom: 8px; }
.results-view.large .hidden-results { padding: 48px 0; }
.results-view.large .hidden-results .big-count { font-size: calc(var(--fit, 1) * clamp(5rem, 16vw, 12rem)); margin-bottom: 12px; }
.results-view.large .hidden-results p { font-size: clamp(1.3rem, 2.6vw, 2.2rem); }
.results-view.large .sbar { margin: 18px 0; }
.results-view.large .sbar-head { font-size: clamp(1.1rem, 1.8vw, 1.7rem); margin-bottom: 8px; }
.results-view.large .sbar-track { height: clamp(18px, 2.4vw, 36px); }
.results-view.large .slide-average strong { font-size: clamp(2.5rem, 5vw, 4rem); }
.results-view.large .slide-average span { font-size: 1.2rem; color: var(--text-muted); }
.results-view.large .slide-total { font-size: 1.05rem; }
.results-view.large .donut { width: clamp(220px, 40vh, 380px); }
.results-view.large .donut-center strong { font-size: clamp(2.5rem, 5vw, 4.5rem); }
.results-view.large .donut-legend { font-size: clamp(1.1rem, 1.8vw, 1.7rem); gap: 14px; max-width: 560px; }
/* Rating scales can have many values: one compact line each, so ten of them stay short on a phone. */
.results-view.rating:not(.projector) .sbar { display: grid; grid-template-columns: 2.4ch 1fr 3.6ch; align-items: center; gap: 10px; margin: 7px 0; }
.results-view.rating:not(.projector) .sbar-head { display: contents; margin: 0; }
.results-view.rating:not(.projector) .sbar-head .label { order: 1; }
.results-view.rating:not(.projector) .sbar-track { order: 2; height: 10px; }
.results-view.rating:not(.projector) .sbar-head .count { order: 3; text-align: right; }
.results-view.rating.large:not(.projector) .sbar-track { height: clamp(12px, 1.6vw, 22px); }

/* Projector: label | bar | count rows, as on the big results screen. */
.results-view.projector .sbar { display: grid; grid-template-columns: minmax(120px, 340px) 1fr 190px; align-items: center; gap: calc(var(--fit, 1) * 24px); margin: 0 0 calc(var(--fit, 1) * clamp(5px, 1.2vh, 18px)); font-size: calc(var(--fit, 1) * clamp(1rem, min(2.2vw, 3vh), 2rem)); }
.results-view.projector .sbar-head { display: contents; font-size: inherit; margin: 0; }
.results-view.projector .sbar-head .label { order: 1; text-align: right; font-weight: 600; overflow-wrap: anywhere; }
.results-view.projector .sbar-track { order: 2; height: calc(var(--fit, 1) * clamp(16px, min(3.4vw, 3.4vh), 56px)); border-radius: 0; background: var(--surface); border: 1px solid var(--border); }
.results-view.projector .sbar-fill { border-radius: 0; }
.results-view.projector .sbar-head .count { order: 3; font-weight: 700; }
.results-view.projector .slide-average { margin-top: calc(var(--fit, 1) * clamp(8px, 2.4vh, 36px)); gap: 14px; }
.results-view.projector .slide-average strong { font-size: calc(var(--fit, 1) * clamp(2rem, min(5vw, 7vh), 4rem)); }
.results-view.projector .slide-total { display: none; }
@media (max-width: 720px) {
  .results-view.projector .sbar { grid-template-columns: 1fr 90px; gap: 6px 12px; }
  .results-view.projector .sbar-head .label { grid-column: 1 / -1; text-align: left; }
  .results-view.projector .sbar-track { height: 32px; }
}
</style>
