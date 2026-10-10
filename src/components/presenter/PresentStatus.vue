<script setup lang="ts">
import type { StatusLine } from '@/lib/presenter';

defineProps<{ lines: StatusLine[] }>();
</script>

<template>
  <ul class="present-status" aria-label="What the audience sees">
    <li v-for="line in lines" :key="line.key" class="chip" :class="line.tone">{{ line.text }}</li>
  </ul>
</template>

<style>
.present-status { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.present-status .chip { font-size: .78rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
.present-status .chip.on { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.present-status .chip.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.present-status .chip.ok { background: var(--success-soft); color: var(--success); border-color: transparent; }
</style>
