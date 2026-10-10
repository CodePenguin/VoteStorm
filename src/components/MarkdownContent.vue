<script setup lang="ts">
import { ref, watch } from 'vue';
import { plainText, renderMarkdown } from '@/lib/markdown';

const props = defineProps<{ source: string; large?: boolean }>();
// `html` is always plainText() or the output of renderMarkdown() (sanitised), so v-html below is safe.
const html = ref(plainText(props.source));
let latest = 0;

// The markdown library loads on first use, so show the plain text meanwhile; a slow render for an older source is dropped.
// If the library cannot load, the plain text stays (the next source change tries again).
watch(
  () => props.source,
  async (source) => {
    const mine = ++latest;
    html.value = plainText(source);
    try {
      const rendered = await renderMarkdown(source);
      if (mine === latest) html.value = rendered;
    } catch {
      // keep the plain text
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="md" :class="{ large }" v-html="html"></div>
</template>
