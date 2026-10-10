<script setup lang="ts">
import { computed } from 'vue';
import { parseHiddenWords } from '@/lib/presenter';
import { wordsOf } from '@/lib/tally';
import type { PresenterStore } from '@/composables/usePresenter';
import type { AdminCloud } from '@/shared/types';

/** headingLevel: the "Removed" heading's level where it sits (3 in the editor's cloud card, 2 on the Present stage). */
const props = withDefaults(defineProps<{ cloud: AdminCloud; store: PresenterStore; headingLevel?: 2 | 3 }>(), { headingLevel: 3 });
const words = computed(() => wordsOf(props.cloud.tally));
const removed = computed(() => parseHiddenWords(props.cloud));
</script>

<template>
  <div class="word-moderation">
    <p v-if="!words.length" class="muted">No words yet</p>
    <ul v-else class="word-chips" aria-label="Words sent">
      <li v-for="w in words" :key="w.word" class="word-chip">
        <span class="word-text">{{ w.word }}</span> <span class="muted">{{ w.count }}</span>
        <button type="button" :aria-label="`Remove ${w.word}`" @click="store.hideWord(cloud, w.word)">&times;</button>
      </li>
    </ul>
    <template v-if="removed.length">
      <component :is="`h${headingLevel}`" class="word-removed-title">Removed</component>
      <ul class="word-chips" aria-label="Removed words">
        <li v-for="w in removed" :key="w" class="word-chip removed">
          <span class="word-text">{{ w }}</span>
          <button type="button" :aria-label="`Restore ${w}`" @click="store.showWord(cloud, w)">&#8617;</button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style>
.word-moderation { margin-top: 12px; }
.word-moderation .word-text { overflow-wrap: anywhere; min-width: 0; }
.word-moderation .word-chip { max-width: 100%; }
.word-chip.removed { background: var(--surface-2); color: var(--text-muted); text-decoration: line-through; }
.word-chip.removed button { text-decoration: none; }
.word-removed-title { font-size: .85rem; font-weight: 600; color: var(--text-muted); margin: 14px 0 8px; }
</style>
