<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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

const dialog = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

const focusable = () =>
  Array.from(dialog.value?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((el) => !el.hasAttribute('disabled'));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close');
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep Tab inside the dialog while it is open.
  const items = focusable();
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !dialog.value?.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !dialog.value?.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKey);
  await nextTick();
  focusable()[0]?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  opener?.focus();
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div ref="dialog" class="card modal" role="dialog" aria-modal="true" aria-label="Share this poll">
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
