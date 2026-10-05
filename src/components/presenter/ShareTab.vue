<script setup lang="ts">
import { ref } from 'vue';
import QrCode from '@/components/QrCode.vue';
import { copyText } from '@/composables/useClipboard';

const props = defineProps<{ roomCode: string; resultsKey: string | null }>();
const emit = defineEmits<{ copyFailed: [] }>();

const copied = ref<string | null>(null);
const kinds = [
  { kind: 'vote', title: 'Audience', alt: 'audience' },
  { kind: 'results', title: 'Results', alt: 'results' },
] as const;

const urlFor = (kind: string) => `${window.location.origin}/${kind}/${kind === 'results' ? props.resultsKey : props.roomCode}`;

async function copy(kind: string) {
  if (await copyText(urlFor(kind))) {
    copied.value = kind;
    setTimeout(() => {
      if (copied.value === kind) copied.value = null;
    }, 1500);
  } else {
    emit('copyFailed');
  }
}
</script>

<template>
  <div class="share-grid">
    <div v-for="k in kinds" :key="k.kind" class="card share-card">
      <div class="card-title">{{ k.title }}</div>
      <QrCode v-if="k.kind === 'vote' || resultsKey" :value="urlFor(k.kind)" :label="`QR code for the ${k.alt} page`" />
      <a class="share-url" :href="urlFor(k.kind)" target="_blank">{{ urlFor(k.kind) }}</a>
      <button class="btn" @click="copy(k.kind)">{{ copied === k.kind ? 'Copied!' : 'Copy link' }}</button>
    </div>
  </div>
</template>

<style>
.share-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.share-card { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
.share-card .card-title { margin-bottom: 0; align-self: flex-start; }
.share-card .btn { margin-top: auto; }
.share-card .qr-box { width: min(220px, 100%); padding: 12px; border-radius: var(--radius-sm); }
.share-url { max-width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85rem; overflow-wrap: anywhere; }
@media (max-width: 560px) { .share-grid { grid-template-columns: 1fr; } }
</style>
