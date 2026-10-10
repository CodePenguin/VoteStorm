<script setup lang="ts">
import { computed, ref } from 'vue';
import CloudResults from '@/components/CloudResults.vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import WordModeration from '@/components/presenter/WordModeration.vue';
import { firstLine, kindName, parseCorrect, parseOptions, phaseText, toPrivateCloud } from '@/lib/presenter';
import { responsesLabel } from '@/lib/tally';
import { useOverflows } from '@/composables/useOverflows';
import type { VotingPhase } from '@/composables/useVotingClock';
import type { PresenterStore } from '@/composables/usePresenter';
import type { AdminCloud } from '@/shared/types';

const props = defineProps<{ cloud: AdminCloud | null; next: AdminCloud | null; store: PresenterStore; phase: VotingPhase; label: string }>();

const isQuestion = computed(() => props.cloud?.kind === 'choice' || props.cloud?.kind === 'rating');
const total = computed(() => props.cloud?.tally.totalVotes || 0);
const correctText = computed(() => {
  const c = props.cloud;
  if (!c || !isQuestion.value || !c.correct) return '';
  const options = parseOptions(c);
  return parseCorrect(c).map((i) => options[i]).filter(Boolean).join(', ');
});
const isContent = computed(() => props.cloud?.kind === 'content');
/** The countdown pill: the time left while running, the kind's closed wording once ended, else nothing. */
const countdown = computed(() => {
  if (props.phase === 'running') return { text: props.label, ended: false };
  if (props.phase === 'closed') return { text: phaseText(props.cloud?.kind ?? 'choice').closed, ended: true };
  return null;
});
const preview = ref<HTMLElement | null>(null);
const previewClipped = useOverflows(preview);
</script>

<template>
  <main class="stage" aria-label="Current cloud">
    <!-- The page heading and any error, from the panel: inside the main landmark, at the top of the stage. -->
    <slot />
    <template v-if="cloud">
      <!-- A long content body takes the stage's full width: the countdown floats at its top right instead of holding a column. -->
      <div v-if="isContent" class="stagehead content">
        <span v-if="countdown" class="countdown" :class="{ ended: countdown.ended }" role="timer">{{ countdown.text }}</span>
        <div class="stage-title stage-body"><MarkdownContent :source="cloud.body" /></div>
      </div>
      <div v-else class="stagehead">
        <div class="stage-title"><MarkdownContent :source="cloud.body" /></div>
        <span v-if="countdown" class="countdown" :class="{ ended: countdown.ended }" role="timer">{{ countdown.text }}</span>
      </div>

      <p v-if="cloud.kind === 'words'" class="stage-meta"><strong>{{ total }}</strong> {{ total === 1 ? 'person has' : 'people have' }} sent words</p>
      <p v-else-if="isQuestion" class="stage-meta"><strong>{{ total }}</strong> {{ responsesLabel(total) }}</p>

      <p v-if="!isContent && cloud.results_hidden" class="stage-hint">Results are hidden from the audience. You can still see them here.</p>
      <CloudResults v-if="isQuestion" :cloud="toPrivateCloud(cloud)" :tally="cloud.tally" hide-total />
      <template v-if="cloud.kind === 'words'">
        <WordModeration :cloud="cloud" :store="store" :heading-level="2" />
        <h2 class="stage-section">What the room sees (preview)</h2>
        <div ref="preview" class="word-preview" :class="{ overflowing: previewClipped }"><CloudResults :cloud="toPrivateCloud(cloud)" :tally="cloud.tally" hide-total /></div>
      </template>

      <p v-if="correctText" class="correct-note">
        Correct answer: {{ correctText }}<span v-if="!cloud.answer_shown"> (hidden from audience)</span>
      </p>
    </template>
    <p v-else class="stage-empty">No cloud is live</p>

    <p v-if="next" class="upnext">Up next: <b>{{ firstLine(next.body) }}</b> <span aria-hidden="true">&middot;</span> {{ kindName(next) }}</p>
  </main>
</template>

<style>
.stage { flex: 1; min-width: 0; min-height: 0; padding: clamp(18px, 4vw, 48px); overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.stage .stagehead { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.stage .stagehead.content { display: flow-root; }
.stage .stagehead.content .countdown { float: right; margin: 0 0 12px 24px; }
.stage-title { min-width: 0; font-size: clamp(1.5rem, 3.2vw, 2.4rem); line-height: 1.15; font-weight: 400; }
.stage-title .md > p:only-child { font-weight: 800; }
.stage-title .md :is(h2, h3, h4, h5, h6) { font-size: inherit; font-weight: 800; margin: 0 0 .4em; }
.stage-title.stage-body { font-size: clamp(1.2rem, 2.4vw, 1.9rem); line-height: 1.35; }
.stage-title .md img { max-height: 50vh; object-fit: contain; }
.stage .countdown { flex: none; padding: 4px 16px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: clamp(1.3rem, 2.4vw, 1.9rem); font-weight: 800; font-variant-numeric: tabular-nums; }
.stage .countdown.ended { background: var(--warn-soft); color: var(--warn); }
.stage-meta { margin: 0; color: var(--text-muted); }
.stage-meta strong { font-size: 1.6rem; color: var(--accent); margin-right: 6px; }
.stage-hint { margin: 0; font-size: .85rem; color: var(--text-muted); }
.stage-section { margin: 8px 0 0; font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
/* A small preview, as in the mockup: it never shrinks away in the flex column (the stage scrolls instead), it is bounded, and
   when the words do not fit it fades out at the bottom rather than cutting a line of words in half. */
.stage .word-preview { flex: none; max-height: clamp(96px, 22vh, 190px); overflow: hidden; padding: 10px 14px; border: 1px solid var(--border); border-radius: 12px; }
/* A miniature: the cloud's word sizes span 1x to 4x, so a small base keeps the biggest word near the mockup's size. */
.stage .word-preview .word-cloud { font-size: .62rem; }
.stage .word-preview.overflowing { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 52px), transparent calc(100% - 10px)); mask-image: linear-gradient(to bottom, #000 calc(100% - 52px), transparent calc(100% - 10px)); }
.stage .word-removed-title { margin: 14px 0 8px; font-size: .72rem; font-weight: 400; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
.stage .correct-note { align-self: flex-start; margin: 0; padding: 8px 14px; border-radius: 10px; background: var(--success-soft); color: var(--success); font-weight: 600; }
.stage-empty { margin: auto; font-size: clamp(1.4rem, 3vw, 2.2rem); color: var(--text-muted); font-weight: 700; }
.stage .upnext { margin: auto 0 0; padding-top: 14px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: .95rem; }
.stage .upnext b { color: var(--text); }
</style>
