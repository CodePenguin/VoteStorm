<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PresentDock from '@/components/presenter/PresentDock.vue';
import PresentStage from '@/components/presenter/PresentStage.vue';
import { presentStatus } from '@/lib/presenter';
import { useFullscreen } from '@/composables/useFullscreen';
import { usePresentKeys } from '@/composables/usePresentKeys';
import { usePresentLayout } from '@/composables/usePresentLayout';
import { useVotingClock } from '@/composables/useVotingClock';
import type { PresenterStore } from '@/composables/usePresenter';

const props = defineProps<{ store: PresenterStore; editing: boolean; stormName: string }>();
const emit = defineEmits<{ edit: []; exit: []; 'close-edit': [] }>();

const DOCK_KEY = 'votestorm_dock_collapsed';
const ARMED_MS = 4000;

const cloud = computed(() => props.store.currentQ.value);
const next = computed(() => {
  const i = props.store.currentIndex.value;
  return i >= 0 ? props.store.clouds.value[i + 1] ?? null : null;
});
const clock = useVotingClock(() => cloud.value?.voting_ms_left);
const layout = usePresentLayout();
const fs = useFullscreen();
const fullscreen = computed(() => ({ supported: fs.supported, active: fs.active.value }));
const sheetOpen = ref(false);
// The Controls sheet exists only with the bottom bar. Widening the window (or rotating a tablet) to the rail layout closes
// it, and only a sheet that is actually shown may block the shortcuts or take Escape.
watch(() => layout.rail.value, (rail) => rail && (sheetOpen.value = false));
const sheetShown = computed(() => sheetOpen.value && !layout.rail.value);

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) === '1';
  } catch {
    return false;
  }
}
const collapsed = ref(readCollapsed());
function toggleDock() {
  // The phone bar has nothing to collapse: D does nothing there, rather than saving a state the presenter never sees.
  if (!layout.rail.value) return;
  collapsed.value = !collapsed.value;
  try {
    if (collapsed.value) localStorage.setItem(DOCK_KEY, '1');
    else localStorage.removeItem(DOCK_KEY);
  } catch {
    /* storage unavailable: the dock just is not remembered */
  }
}

const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | null = null;
function disarm() {
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  armed.value = false;
}
function arm() {
  disarm();
  armed.value = true;
  armTimer = setTimeout(disarm, ARMED_MS);
}
// A timer started from a chip ends the armed state too, and so does opening the edit overlay (the digits are inert there).
watch(() => clock.phase.value, (phase) => phase === 'running' && disarm());
watch(() => props.editing, (editing) => editing && disarm());

// On a phone the status lives in the sheet; above the bar only what differs from the default: not the open state (that is
// the default), not a running timer (the bar's Timer button already counts down), and nothing neutral.
const barLines = computed(() =>
  presentStatus({ cloud: cloud.value, phase: clock.phase.value, label: clock.label.value, showConnect: props.store.showConnect.value }).filter(
    (l) => l.tone !== 'neutral' && !(l.key === 'state' && clock.phase.value !== 'closed'),
  ),
);

usePresentKeys(
  {
    prev: () => props.store.canStep(-1) && props.store.stepCloud(-1),
    next: () => props.store.canStep(1) && props.store.stepCloud(1),
    arm: () => cloud.value && arm(),
    startTimer: (seconds) => {
      disarm();
      if (cloud.value) void props.store.startTimer(cloud.value, seconds);
    },
    toggleResults: () => {
      const c = cloud.value;
      if (c && c.kind !== 'content') void props.store.setCloudFlag({ cloudId: c.id, resultsHidden: !c.results_hidden });
    },
    toggleJoin: () => void props.store.setConnect(!props.store.showConnect.value),
    edit: () => cloud.value && emit('edit'),
    fullscreen: () => void fs.toggle(),
    dock: toggleDock,
    // Escape closes whatever is on top first: the Controls sheet, the edit overlay, the armed timer keys; then it leaves.
    escape: () => {
      if (sheetShown.value) sheetOpen.value = false;
      else if (props.editing) {
        disarm();
        emit('close-edit');
      }
      else if (armed.value) disarm();
      else emit('exit');
    },
  },
  () => ({ overlayOpen: props.editing || sheetShown.value, armed: armed.value }),
  () => true,
);

onMounted(() => document.documentElement.classList.add('presenting'));
onBeforeUnmount(() => {
  disarm();
  document.documentElement.classList.remove('presenting');
  void fs.exit();
});
</script>

<template>
  <!-- Landmarks: the stage is the top-level main (with the page's h1 and any error at its top), the dock a labelled aside. -->
  <div class="present-stage" :class="layout.rail.value ? 'with-rail' : 'with-bar'">
    <PresentStage :cloud="cloud" :next="next" :store="store" :phase="clock.phase.value" :label="clock.label.value">
      <h1 class="sr-only">Presenting</h1>
      <div v-if="store.error.value" class="alert error present-error" role="alert">
        <span>Couldn't complete that: {{ store.error.value }}</span>
        <button class="btn sm" @click="store.error.value = null">Dismiss</button>
      </div>
    </PresentStage>
    <PresentDock
      v-model:sheet="sheetOpen"
      :store="store" :cloud="cloud" :phase="clock.phase.value" :label="clock.label.value" :show-title="layout.showTitle.value" :storm-name="stormName"
      :armed="armed" :fullscreen="fullscreen" :rail="layout.rail.value" :collapsed="collapsed" :bar-lines="barLines"
      @edit="emit('edit')" @exit="emit('exit')" @fullscreen="fs.toggle()" @toggle-dock="toggleDock"
    />
  </div>
</template>

<style>
html.presenting { overflow: hidden; }
/* The stage covers the page: the footer behind it must not stay in the Tab order or the landmarks. */
html.presenting .app-footer { display: none; }
.present-stage { position: fixed; inset: 0; z-index: 30; display: flex; background: var(--bg); color: var(--text); }
.present-stage.with-bar { flex-direction: column; }
/* At the top of the stage, and kept in view while the stage scrolls. */
.present-error { flex: none; position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0; }
</style>
