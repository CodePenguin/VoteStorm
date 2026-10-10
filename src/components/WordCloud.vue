<script setup lang="ts">
import { computed } from 'vue';
import { stableOrder, wordHash, wordScale } from '@/lib/wordCloud';

const props = defineProps<{ words: { word: string; count: number }[]; large?: boolean }>();

const ordered = computed(() => {
  const counts = props.words.map((w) => w.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return stableOrder(props.words).map((w) => ({ ...w, size: wordScale(w.count, min, max), tone: wordHash(w.word) % 3 }));
});
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
</script>

<template>
  <p v-if="words.length === 0" class="word-cloud-empty">Waiting for words&hellip;</p>
  <ul v-else class="word-cloud" :class="{ large }" :aria-label="`Word cloud, ${words.length} ${words.length === 1 ? 'word' : 'words'}`">
    <li v-for="w in ordered" :key="w.word" :class="`tone-${w.tone}`" :style="{ fontSize: `${w.size}em` }">
      {{ w.word }}<span class="sr-only">, {{ people(w.count) }}</span>
    </li>
  </ul>
</template>
