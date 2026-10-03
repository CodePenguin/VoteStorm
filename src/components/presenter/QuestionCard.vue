<script setup lang="ts">
import { computed } from 'vue';
import { parseCorrect, parseOptions } from '@/lib/presenter';
import type { PresenterStore } from '@/composables/usePresenter';
import type { AdminQuestion } from '@/shared/types';

const props = defineProps<{ q: AdminQuestion; index: number; count: number; isLive: boolean; store: PresenterStore }>();
const emit = defineEmits<{ edit: [q: AdminQuestion] }>();

const options = computed(() => parseOptions(props.q));
const correct = computed(() => parseCorrect(props.q));
const typeLabel = computed(() =>
  props.q.type === 'choice' ? (props.q.multi ? 'Multi-select' : 'Choice') : `Rating ${props.q.scale_min}\u2013${props.q.scale_max}`,
);
</script>

<template>
  <div class="card question" :class="{ active: isLive }">
    <div class="q-head">
      <div class="q-num">{{ index + 1 }}</div>
      <div style="flex: 1; min-width: 0">
        <div class="q-prompt">{{ q.prompt }}</div>
        <div class="q-meta">
          <span class="badge">{{ typeLabel }}</span>
          <span v-if="isLive" class="badge active"><span class="dot pulse"></span>Live now</span>
          <span v-if="q.type === 'choice' && q.display === 'donut'" class="badge">Donut</span>
          <span v-if="q.results_hidden" class="badge">Results hidden</span>
          <span v-if="q.correct" class="badge">Has answer</span>
        </div>
      </div>
      <button class="icon-btn" aria-label="Edit question" title="Edit question" @click="emit('edit', q)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      </button>
    </div>

    <div class="q-setup">
      <div v-if="q.type === 'choice'" class="chips">
        <span v-for="(opt, i) in options" :key="i" class="chip" :class="{ correct: correct.includes(i) }">{{ opt }}{{ correct.includes(i) ? ' \u2713' : '' }}</span>
      </div>
      <span v-else class="muted">Rating scale {{ q.scale_min }} to {{ q.scale_max }}</span>
    </div>

    <div class="q-actions">
      <button v-if="!isLive" class="btn sm primary" @click="store.activate(q.id)">Activate</button>
      <button class="btn sm" title="Results screen for this question. Opening it makes the question live, so it can drive a slide." @click="store.copyQuestionLink(q)">
        {{ store.copiedQuestion.value === q.id ? 'Copied!' : 'Copy results link' }}
      </button>
      <button v-if="index > 0" class="btn sm" aria-label="Move up" @click="store.swap(index, index - 1)">&uarr; Up</button>
      <button v-if="index < count - 1" class="btn sm" aria-label="Move down" @click="store.swap(index, index + 1)">&darr; Down</button>
      <span class="spacer"></span>
      <button class="btn sm" @click="store.resetQuestion(q.id)">Reset votes</button>
      <button class="btn sm danger" @click="store.deleteQuestion(q.id)">Delete</button>
    </div>
  </div>
</template>
