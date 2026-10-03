<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import QrCode from './QrCode.vue';
import { copyText } from '@/composables/useClipboard';

const props = defineProps<{ url: string }>();
const emit = defineEmits<{ close: [] }>();

const copied = ref(false);
const label = props.url.replace(/^https?:\/\//, '');

async function copy() {
  if (await copyText(props.url)) {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="card modal" role="dialog" aria-modal="true" aria-label="Share this poll">
      <h2>Invite others</h2>
      <p class="muted">Scan to open this poll</p>
      <QrCode :value="url" label="QR code linking to this poll" />
      <p class="share-link">{{ label }}</p>
      <div class="row">
        <button class="btn primary" @click="copy">{{ copied ? 'Copied!' : 'Copy link' }}</button>
        <button class="btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>
