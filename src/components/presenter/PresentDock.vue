<script setup lang="ts">
import { ref } from 'vue';
import PresentControls from '@/components/presenter/PresentControls.vue';
import PresentStatus from '@/components/presenter/PresentStatus.vue';
import { focusables, useDialogFocus } from '@/composables/useDialogFocus';
import type { PresenterStore } from '@/composables/usePresenter';
import type { VotingPhase } from '@/composables/useVotingClock';
import type { StatusLine } from '@/lib/presenter';
import type { AdminCloud } from '@/shared/types';

withDefaults(
  defineProps<{
    store: PresenterStore;
    cloud: AdminCloud | null;
    phase: VotingPhase;
    label: string;
    showTitle: boolean;
    stormName: string;
    armed: boolean;
    fullscreen: { supported: boolean; active: boolean };
    rail: boolean;
    collapsed: boolean;
    /** The one-line status above the phone bar: only what differs from the default. */
    barLines?: StatusLine[];
  }>(),
  { barLines: () => [] },
);
const emit = defineEmits<{ edit: []; exit: []; fullscreen: []; 'toggle-dock': [] }>();

// The page's key handler needs to know when the sheet is open (its shortcuts are inert and Escape closes it), so it is a model.
const sheetOpen = defineModel<boolean>('sheet', { default: false });
const sheet = ref<HTMLElement | null>(null);

/** The one dock landmark shown at a time: the rail, the collapsed handle's aside, or the phone bar. */
const dockEl = ref<HTMLElement | null>(null);

/**
 * Where focus goes when the sheet closes and its opener is gone: the window widened to the rail layout while the sheet was
 * open (the bar and its Controls button went with it). Edit cloud on the rail, else the dock's first usable control (the
 * collapsed handle, say).
 */
function sheetFallback(): HTMLElement | null {
  const items = dockEl.value ? focusables(dockEl.value) : [];
  return items.find((el) => el.classList.contains('edit-cloud')) ?? items[0] ?? null;
}
useDialogFocus(sheet, sheetOpen, sheetFallback);

function through(event: 'edit' | 'exit' | 'fullscreen') {
  sheetOpen.value = false;
  if (event === 'edit') emit('edit');
  else if (event === 'exit') emit('exit');
  else emit('fullscreen');
}
</script>

<template>
  <template v-if="rail">
    <aside v-if="!collapsed" ref="dockEl" class="rail" aria-label="Presenter controls">
      <PresentControls
        :store="store" :cloud="cloud" :phase="phase" :label="label" :show-title="showTitle" :storm-name="stormName" :armed="armed" :fullscreen="fullscreen"
        @edit="emit('edit')" @exit="emit('exit')" @fullscreen="emit('fullscreen')" @dock="emit('toggle-dock')"
      />
    </aside>
    <aside v-else ref="dockEl" class="dock-collapsed" aria-label="Presenter controls">
      <button class="dock-handle" @click="emit('toggle-dock')"><span aria-hidden="true">&lsaquo;</span> <span class="sr-only">Show </span>Controls</button>
    </aside>
  </template>
  <aside v-else ref="dockEl" class="dock-bar" aria-label="Presenter controls">
    <div v-if="barLines.length || armed" class="bar-status">
      <PresentStatus v-if="barLines.length" :lines="barLines" />
      <p v-if="armed" class="present-hint">Press 1 to 5</p>
    </div>
    <div class="bar-row">
      <button class="btn lg bar-step prev" aria-label="Previous" :disabled="!store.canStep(-1)" @click="store.stepCloud(-1)">&lsaquo;</button>
      <button class="btn primary lg bar-step next" :disabled="!store.canStep(1)" @click="store.stepCloud(1)">Next &rsaquo;</button>
      <button v-if="cloud" class="btn lg bar-timer" :class="{ armed }" @click="sheetOpen = true">{{ phase === 'running' ? label : 'Timer' }}</button>
      <button class="btn lg bar-controls" @click="sheetOpen = true">Controls</button>
    </div>
    <template v-if="sheetOpen">
      <div class="sheet-dim" @click="sheetOpen = false"></div>
      <div ref="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="Controls" tabindex="-1" @keydown.esc.stop="sheetOpen = false">
        <PresentControls
          :store="store" :cloud="cloud" :phase="phase" :label="label" :show-title="false" :storm-name="stormName" :armed="armed" :fullscreen="fullscreen" sheet
          @edit="through('edit')" @exit="through('exit')" @fullscreen="through('fullscreen')" @close="sheetOpen = false"
        />
      </div>
    </template>
  </aside>
</template>

<style>
.rail { width: 280px; flex: none; border-left: 1px solid var(--border); background: var(--surface); padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; }
.dock-collapsed { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 35; }
/* The collapsed dock: a tab on the right edge that says what it is, with a border that stands out from the page (>= 3:1). */
.dock-handle { display: flex; align-items: center; gap: 6px; writing-mode: vertical-rl; padding: 14px 7px; border-radius: 10px 0 0 10px; border: 2px solid var(--text-muted); border-right: 0; background: var(--surface); color: var(--text); font: inherit; font-size: .85rem; font-weight: 700; letter-spacing: .02em; cursor: pointer; box-shadow: -2px 0 10px rgba(15,23,42,.12); }
.dock-handle:hover { background: var(--surface-2); }
.dock-bar { flex: none; border-top: 1px solid var(--border); background: var(--surface); }
.dock-bar .bar-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px 0; }
.dock-bar .bar-row { display: grid; grid-auto-flow: column; grid-template-columns: 1fr 1fr; grid-auto-columns: auto; gap: 8px; padding: 10px; }
.dock-bar .bar-row .btn { justify-content: center; padding-left: 14px; padding-right: 14px; }
.dock-bar .bar-step { min-height: 44px; }
.dock-bar .bar-timer { font-variant-numeric: tabular-nums; }
.dock-bar .bar-timer.armed { outline: 2px solid var(--accent); outline-offset: 2px; }
.sheet { position: fixed; left: 0; right: 0; bottom: 0; top: 14%; background: var(--surface); border-radius: 18px 18px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.3); padding: 16px; overflow-y: auto; z-index: 45; }
.sheet-dim { position: fixed; inset: 0; background: rgba(15,23,42,.4); z-index: 44; }
</style>
