<script setup lang="ts">
import { computed, ref } from 'vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import { kindLabel, parseCorrect, parseOptions } from '@/lib/presenter';
import type { PresenterStore } from '@/composables/usePresenter';
import { useOverflows } from '@/composables/useOverflows';
import type { AdminCloud } from '@/shared/types';

const props = defineProps<{ q: AdminCloud; index: number; count: number; isLive: boolean; store: PresenterStore }>();
const emit = defineEmits<{ edit: [q: AdminCloud] }>();

const options = computed(() => parseOptions(props.q));
const correct = computed(() => parseCorrect(props.q));
const typeLabel = computed(() => kindLabel(props.q));
const promptBox = ref<HTMLElement | null>(null);
const clipped = useOverflows(promptBox);
</script>

<template>
  <div class="card cloud" :class="{ active: isLive }">
    <div class="q-head">
      <div class="q-num">{{ index + 1 }}</div>
      <div style="flex: 1; min-width: 0">
        <div ref="promptBox" class="q-prompt clamp" :class="{ overflowing: clipped }"><MarkdownContent :source="q.body" /></div>
        <div class="q-meta">
          <span class="badge">{{ typeLabel }}</span>
          <span v-if="isLive" class="badge active"><span class="dot pulse"></span>Live now</span>
          <span v-if="q.kind === 'choice' && q.display === 'donut'" class="badge">Donut</span>
          <span v-if="q.results_hidden" class="badge">Results hidden</span>
          <span v-if="q.correct" class="badge">Has answer</span>
        </div>
      </div>
      <button class="icon-btn" aria-label="Edit cloud" title="Edit cloud" @click="emit('edit', q)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      </button>
    </div>

    <div v-if="q.kind !== 'content'" class="q-setup">
      <div v-if="q.kind === 'choice'" class="chips">
        <span v-for="(opt, i) in options" :key="i" class="chip" :class="{ correct: correct.includes(i) }">{{ opt }}{{ correct.includes(i) ? ' ✓' : '' }}</span>
      </div>
      <span v-else-if="q.kind === 'words'" class="muted">People send up to {{ q.max_words ?? 3 }} words</span>
      <span v-else class="muted">Rating scale {{ q.scale_min }} to {{ q.scale_max }}</span>
    </div>

    <div class="q-actions">
      <button v-if="!isLive" class="btn sm primary" @click="store.activate(q.id)">Activate</button>
      <button v-if="q.kind !== 'content'" class="btn sm" title="Results screen for this cloud. Opening it makes the cloud live, so it can drive a slide." @click="store.copyCloudLink(q)">
        {{ store.copiedCloud.value === q.id ? 'Copied!' : 'Copy results link' }}
      </button>
      <button v-if="index > 0" class="btn sm" aria-label="Move up" @click="store.swap(index, index - 1)">&uarr; Up</button>
      <button v-if="index < count - 1" class="btn sm" aria-label="Move down" @click="store.swap(index, index + 1)">&darr; Down</button>
      <span class="spacer"></span>
      <button v-if="q.kind !== 'content'" class="btn sm" @click="store.resetCloud(q.id)">Reset votes</button>
      <button class="btn sm danger" @click="store.deleteCloud(q.id)">Delete</button>
    </div>
  </div>
</template>

<style>
.q-prompt.clamp { max-height: 7.5em; overflow: hidden; }
/* A card shows the start of a body: its headings stay at the card's text size, and a cut-off body fades out. */
.q-prompt .md :is(h2, h3, h4, h5, h6) { font-size: inherit; margin: 0 0 .3em; }
.q-prompt.clamp.overflowing { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent); }
</style>
