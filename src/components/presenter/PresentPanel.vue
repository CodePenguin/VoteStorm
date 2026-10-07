<script setup lang="ts">
import { computed } from 'vue';
import QuestionResults from '@/components/QuestionResults.vue';
import { toPrivateQuestion } from '@/lib/presenter';
import { responsesLabel } from '@/lib/tally';
import { useVotingClock } from '@/composables/useVotingClock';
import type { PresenterStore } from '@/composables/usePresenter';

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
const total = computed(() => q.value?.tally.totalVotes || 0);
</script>

<template>
  <div class="present">
    <div class="card present-now">
      <div class="card-title">Now showing</div>
      <template v-if="q">
        <h2 class="present-prompt">{{ q.prompt }}</h2>
        <p class="muted" style="margin: 6px 0 16px"><strong class="present-count">{{ total }}</strong> {{ responsesLabel(total) }}</p>
        <div class="toolbar" style="margin-bottom: 16px">
          <button class="btn" @click="store.setQuestionFlag({ questionId: q.id, resultsHidden: !q.results_hidden })">
            {{ q.results_hidden ? 'Show results' : 'Hide results' }}
          </button>
          <button v-if="q.correct" class="btn" @click="store.setQuestionFlag({ questionId: q.id, answerShown: !q.answer_shown })">
            {{ q.answer_shown ? 'Hide answer' : 'Reveal answer' }}
          </button>
          <button class="btn" @click="store.setConnect(!store.showConnect.value)">{{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}</button>
        </div>
        <div class="voting-row">
          <span class="voting-state" :class="clock.phase.value" role="timer">
            <template v-if="clock.phase.value === 'running'">{{ clock.label.value }} left</template>
            <template v-else-if="clock.phase.value === 'closed'">Voting closed</template>
            <template v-else>Voting open</template>
          </span>
          <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.lockVoting(q, true)">Lock now</button>
          <button v-else-if="clock.phase.value === 'closed'" class="btn sm primary" @click="store.lockVoting(q, false)">Unlock voting</button>
          <button v-else class="btn sm" @click="store.lockVoting(q, true)">Lock voting</button>
          <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.addTime(q, 30)">+30s</button>
          <button v-if="clock.phase.value === 'running'" class="btn sm" @click="store.lockVoting(q, false)">Cancel timer</button>
          <span class="timer-chips" role="group" aria-label="Start a timer">
            <span class="muted">Timer</span>
            <button v-for="t in TIMERS" :key="t.seconds" class="btn sm" @click="store.startTimer(q, t.seconds)">{{ t.label }}</button>
          </span>
        </div>
        <div class="q-results">
          <p v-if="q.results_hidden" class="muted" style="font-size: .85rem; margin-bottom: 8px">Results are hidden from the audience. You can still see them here.</p>
          <QuestionResults :question="toPrivateQuestion(q)" :tally="q.tally" hide-total />
        </div>
      </template>
      <template v-else>
        <h2 class="present-prompt muted">No question is live</h2>
        <div class="toolbar" style="margin-top: 12px">
          <button class="btn" @click="store.setConnect(!store.showConnect.value)">{{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}</button>
        </div>
      </template>
    </div>

    <div class="present-nav">
      <button class="btn lg" :disabled="!store.canStep(-1)" @click="store.stepQuestion(-1)">&lsaquo; Previous</button>
      <button class="btn primary lg" :disabled="!store.canStep(1)" @click="store.stepQuestion(1)">Next &rsaquo;</button>
    </div>

    <div v-if="store.questions.value.length" class="card">
      <div v-for="(item, index) in store.questions.value" :key="item.id" class="present-row" :class="{ live: item.id === store.storm.value?.current_question_id }">
        <span class="q-num">{{ index + 1 }}</span>
        <span class="present-row-prompt">{{ item.prompt }}</span>
        <span class="muted present-row-count">{{ item.tally.totalVotes || 0 }}</span>
        <button class="btn sm" title="Results screen for this question. Opening it makes the question live." @click="store.copyQuestionLink(item)">
          {{ store.copiedQuestion.value === item.id ? 'Copied!' : 'Copy link' }}
        </button>
        <button v-if="item.id !== store.storm.value?.current_question_id" class="btn sm primary" @click="store.activate(item.id)">Go live</button>
        <span v-else class="badge active"><span class="dot pulse"></span>Live</span>
      </div>
    </div>
  </div>
</template>

<style>
.present { display: grid; gap: 16px; }
.present-prompt { font-size: clamp(1.4rem, 4vw, 2rem); }
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
