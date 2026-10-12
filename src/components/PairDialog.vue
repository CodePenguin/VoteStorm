<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { focusables, useDialogFocus } from '@/composables/useDialogFocus';
import { openPairTransport } from '@/composables/usePairTransport';
import { formatCode, generateCode, normalizeCode } from '@/lib/pairCrypto';
import { startHost, startJoin, type HostState, type JoinState, type PairFailure } from '@/lib/pairing';
import { loadRecent, mergeRecent, type MergeResult } from '@/lib/recentStorms';
import { retryLabel } from '@/lib/relativeTime';

// One dialog for both devices: it starts by hosting (showing a code), and typing the other device's code switches it to joining.
// Which device plays which part makes no difference to the result. See docs/superpowers/specs/2026-10-11-device-pairing-design.md.
const emit = defineEmits<{ close: []; merged: [] }>();

const dialog = ref<HTMLElement | null>(null);
useDialogFocus(dialog, ref(true), () => document.querySelector<HTMLElement>('.pair-open'));

const REASONS: Record<PairFailure, string> = {
  wrong_code: 'That device did not know the code.',
  no_answer: 'No device answered. Check the code and try again.',
  expired: 'The code expired. Try again for a new one.',
  timeout: 'The other device did not respond in time.',
  invalid: 'The other device sent something that could not be used. Nothing was changed.',
  connection: 'Could not connect. Check your connection and try again.',
  license: 'Syncing needs a license. Add your license on this device, then try again.',
  // Followed by when to try again (see reasonText).
  rate_limited: 'Too many sync attempts for now.',
};

const mode = ref<'host' | 'join'>('host');
const state = ref<HostState | JoinState>({ phase: 'connecting' });
const code = ref('');
const typed = ref('');
const typedError = ref(false);
let session: { cancel(): void; confirm?(): Promise<void> } | null = null;
// Each session gets a number; states from one that has been left behind are ignored.
let generation = 0;
let mergedSent = false;

function onState(gen: number) {
  return (s: HostState | JoinState) => {
    if (gen !== generation) return;
    state.value = s;
    if (s.phase === 'done' && !mergedSent) {
      mergedSent = true;
      emit('merged');
    }
  };
}

function host() {
  session?.cancel();
  const gen = ++generation;
  mode.value = 'host';
  state.value = { phase: 'connecting' };
  code.value = generateCode();
  typed.value = '';
  typedError.value = false;
  session = startHost({ code: code.value, storms: loadRecent(), open: openPairTransport, merge: mergeRecent, onState: onState(gen) });
}

function join() {
  const entered = normalizeCode(typed.value);
  if (!entered) {
    // A mistyped code leaves this device's own code working.
    typedError.value = true;
    return;
  }
  session?.cancel();
  const gen = ++generation;
  mode.value = 'join';
  state.value = { phase: 'connecting' };
  session = startJoin({ code: entered, open: openPairTransport, merge: mergeRecent, list: loadRecent, onState: onState(gen) });
}

function close() {
  session?.cancel();
  stopCountdown();
  emit('close');
}
// Esc and a backdrop click: like Cancel, they do nothing while the list is being sent.
function dismiss() {
  if (mode.value === 'host' && state.value.phase === 'sending') return;
  close();
}

const phase = computed(() => state.value.phase);
const reason = computed(() => (state.value.phase === 'failed' ? state.value.reason : undefined));
const reasonText = computed(() => {
  const s = state.value;
  if (s.phase !== 'failed') return '';
  // Too many attempts says when another is allowed, rounded up; trying sooner would only be refused again.
  return s.reason === 'rate_limited' ? `${REASONS.rate_limited} Try again ${retryLabel(s.retryAfterSeconds)}.` : REASONS[s.reason];
});
const readyCount = computed(() => (state.value.phase === 'ready' ? state.value.count : 0));
const hostingCode = computed(() => mode.value === 'host' && ['connecting', 'waiting'].includes(phase.value));
const confirming = computed(() => mode.value === 'host' && (phase.value === 'ready' || phase.value === 'sending'));
const joining = computed(() => mode.value === 'join' && ['connecting', 'waiting', 'receiving'].includes(phase.value));

const resultText = computed(() => {
  if (state.value.phase !== 'done') return '';
  const r: MergeResult = state.value.result;
  const parts = [r.added && `added ${r.added}`, r.updated && `updated ${r.updated}`, r.kept && `${r.kept} already here`].filter(Boolean) as string[];
  if (parts.length === 0) return 'Already in sync.';
  const text = parts.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
});

// Read out one character at a time, the two groups apart, so a screen reader does not try to say it as a word.
const spokenCode = computed(() => [code.value.slice(0, 5), code.value.slice(5)].map((g) => g.split('').join(' ')).join(', '));

const statusText = computed(() => {
  const p = phase.value;
  if (p === 'done') return resultText.value;
  if (p === 'failed') return '';
  if (mode.value === 'join') {
    if (p === 'connecting') return 'Connecting…';
    if (p === 'waiting') return 'Waiting for the other device…';
    return 'Receiving the Storms…';
  }
  if (p === 'connecting') return 'Getting the code ready…';
  if (p === 'ready') {
    const n = readyCount.value;
    // A device with no Storms of its own is the usual receiver: then there is nothing to count, only the other device's list to take.
    return n === 0 ? 'A device is ready. Sync now?' : `A device is ready. Sync ${n} ${n === 1 ? 'Storm' : 'Storms'}?`;
  }
  if (p === 'sending') return 'Syncing…';
  return '';
});

// The code's countdown runs only while it is on show waiting for the other device.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
function stopCountdown() {
  clearInterval(ticker);
  ticker = undefined;
}
const counting = computed(() => mode.value === 'host' && state.value.phase === 'waiting');
watch(counting, (on) => {
  stopCountdown();
  if (on) {
    now.value = Date.now();
    ticker = setInterval(() => (now.value = Date.now()), 1000);
  }
});
const countdown = computed(() => {
  if (state.value.phase !== 'waiting' || !('expiresAt' in state.value)) return '';
  const left = Math.max(0, Math.ceil((state.value.expiresAt - now.value) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
});

// A control that had focus may vanish as the dialog moves on (Connect, Sync, Try again): focus then stays in the dialog.
watch([mode, phase], async () => {
  await nextTick();
  const root = dialog.value;
  if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus();
});

onMounted(host);
onBeforeUnmount(() => {
  session?.cancel();
  session = null;
  stopCountdown();
});
</script>

<template>
  <div class="modal-backdrop" @click.self="dismiss">
    <div
      ref="dialog" class="card modal pair-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-dialog-title" tabindex="-1"
      :data-mode="mode" :data-phase="phase" :data-reason="reason" @keydown.esc.stop="dismiss"
    >
      <h2 id="pair-dialog-title">Sync your Storms</h2>
      <!-- One live region for the whole dialog, always present, so each change of its text is announced. -->
      <p class="pair-status" role="status">{{ statusText }}<span v-if="mode === 'host' && phase === 'waiting'" class="sr-only">Your code is <span class="pair-status-code">{{ spokenCode }}</span>.</span></p>

      <template v-if="reason">
        <p class="alert error pair-failure" role="alert">{{ reasonText }}</p>
        <div class="pair-actions">
          <!-- Too many attempts has no Try again: another attempt now would only be refused and count against the limit. -->
          <button type="button" class="btn pair-close" :class="{ primary: reason === 'rate_limited' }" @click="close">Close</button>
          <button v-if="reason !== 'rate_limited'" type="button" class="btn primary pair-retry" @click="host">Try again</button>
        </div>
      </template>

      <template v-else-if="phase === 'done'">
        <div class="pair-actions">
          <button type="button" class="btn primary pair-close" @click="close">Close</button>
        </div>
      </template>

      <template v-else-if="confirming">
        <p class="muted pair-note">Both devices end up with the same list.</p>
        <div class="pair-actions">
          <button type="button" class="btn pair-cancel" :disabled="phase === 'sending'" @click="close">Cancel</button>
          <button type="button" class="btn primary pair-sync" :disabled="phase === 'sending'" @click="session?.confirm?.()">
            {{ phase === 'sending' ? 'Syncing…' : 'Sync' }}
          </button>
        </div>
      </template>

      <template v-else-if="joining">
        <div class="pair-actions">
          <button type="button" class="btn" @click="close">Cancel</button>
        </div>
      </template>

      <template v-else-if="hostingCode">
        <!-- The code is shown only once this device is listening for it. -->
        <template v-if="phase === 'waiting'">
          <p class="pair-help">On your other device, open Your Storms, choose Sync with another device and enter this code.</p>
          <!-- Not a live region itself (an output element would be one): the status line above announces the code, spelled out. -->
          <output class="pair-code" aria-label="Pairing code" aria-live="off">{{ formatCode(code) }}</output>
          <p class="muted pair-expiry">Expires in {{ countdown }}</p>
        </template>

        <div class="pair-divider"><span>or</span></div>

        <form class="pair-join" novalidate @submit.prevent="join">
          <label for="pair-input" class="pair-label">Code from the other device</label>
          <div class="pair-join-row">
            <input
              id="pair-input" v-model="typed" class="input pair-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
              :aria-invalid="typedError ? 'true' : undefined" :aria-describedby="typedError ? 'pair-input-error' : undefined" @input="typedError = false"
            >
            <button type="submit" class="btn pair-connect">Connect</button>
          </div>
          <p v-if="typedError" id="pair-input-error" class="pair-input-error" role="alert">Enter the 10-character code shown on the other device.</p>
        </form>

        <div class="pair-actions">
          <button type="button" class="btn pair-close" @click="close">Close</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style>
.pair-dialog { max-width: 420px; }
.pair-dialog p { margin: 8px 0; }
.pair-help { color: var(--text-muted); }
.pair-code {
  display: block; margin: 12px 0 4px; padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: clamp(1.5rem, 7vw, 2rem); font-weight: 700; letter-spacing: .08em;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  user-select: all; overflow-wrap: anywhere;
}
.pair-expiry { font-size: .85rem; font-variant-numeric: tabular-nums; }
.pair-divider { display: flex; align-items: center; gap: 12px; margin: 16px 0 12px; color: var(--text-muted); font-size: .82rem; }
.pair-divider::before, .pair-divider::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
.pair-join { text-align: left; }
.pair-label { display: block; font-size: .82rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
.pair-join-row { display: flex; gap: 8px; }
.pair-input { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: uppercase; }
.pair-input[aria-invalid='true'] { border-color: var(--danger); }
.pair-input-error { color: var(--danger); font-size: .85rem; }
.pair-dialog .pair-status { font-weight: 600; }
.pair-dialog .pair-status:empty { margin: 0; }
.pair-actions { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
</style>
