<script setup lang="ts">
import { ref } from 'vue';
import { useDialogFocus } from '@/composables/useDialogFocus';

const props = defineProps<{
  fileName: string;
  incoming: { name: string | null; clouds: number };
  current: { clouds: number; votes: number };
  error: string | null;
  busy: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

// Shown only while mounted: focus moves in at once, Tab stays inside, and focus goes back to the opener when it closes.
const dialog = ref<HTMLElement | null>(null);
// The native file picker may leave focus on the page body, so the Import control is the fallback.
useDialogFocus(dialog, ref(true), () => document.querySelector<HTMLElement>('.import-json'));

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function cancel() {
  if (!props.busy) emit('cancel');
}
function confirm() {
  if (!props.busy) emit('confirm');
}
</script>

<template>
  <div class="modal-backdrop" @click.self="cancel">
    <div
      ref="dialog" class="card modal import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" aria-describedby="import-summary"
      tabindex="-1" @keydown.esc.stop="cancel"
    >
      <h2 id="import-title">Replace this Storm?</h2>
      <div id="import-summary" class="import-summary">
        <p>
          <strong class="import-file">{{ fileName }}</strong> holds {{ incoming.name ? `“${incoming.name}”` : 'an unnamed Storm' }} with
          <strong class="import-clouds">{{ count(incoming.clouds, 'cloud', 'clouds') }}</strong>.
        </p>
        <p>
          Importing removes this Storm's <strong class="import-current-clouds">{{ count(current.clouds, 'cloud', 'clouds') }}</strong> and their
          <strong class="import-current-votes">{{ count(current.votes, 'vote', 'votes') }}</strong>, and takes the file's name, background and clouds.
          No cloud is live afterwards. This cannot be undone.
        </p>
        <p class="import-links-note">
          Links to single clouds that you copied before will stop working, because the imported clouds are new. Copy them again afterwards.
        </p>
      </div>
      <div v-if="error" class="alert error" role="alert">{{ error }}</div>
      <div class="import-actions">
        <button class="btn import-cancel" :aria-disabled="busy" @click="cancel">Cancel</button>
        <button class="btn danger import-confirm" :aria-disabled="busy" @click="confirm">{{ busy ? 'Importing…' : 'Replace Storm' }}</button>
      </div>
    </div>
  </div>
</template>

<style>
.import-dialog { max-width: 480px; text-align: left; }
.import-summary p { margin: 8px 0; overflow-wrap: anywhere; }
.import-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
</style>
