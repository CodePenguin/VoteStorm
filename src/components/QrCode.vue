<script setup lang="ts">
import { computed } from 'vue';
import qrcode from 'qrcode-generator';

const props = defineProps<{ value: string; label?: string }>();

const svg = computed(() => {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(props.value);
    qr.make();
    return qr.createSvgTag({ scalable: true, margin: 0 });
  } catch {
    return '';
  }
});
</script>

<template>
  <!-- Always on white so it scans in dark mode too. -->
  <div v-if="svg" class="qr-box" role="img" :aria-label="label ?? 'QR code'" v-html="svg"></div>
</template>
