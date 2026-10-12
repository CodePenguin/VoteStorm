<script setup lang="ts">
import { computed } from 'vue';
import type { LicenseLimits } from '@/shared/types';

const props = defineProps<{ limits: LicenseLimits; usage?: { clouds?: number; audience?: number | null; activeStorms?: number } }>();

const capText = (cap: number | undefined) => (cap ? String(cap) : 'Unlimited');
const isFull = (used: number | undefined, cap: number | undefined) => used !== undefined && !!cap && used >= cap;
/** "used / cap" when the current use is known, else just the cap. */
const withUse = (used: number | undefined, cap: number | undefined) => (used === undefined ? capText(cap) : `${used} / ${capText(cap)}`);

function expiryText(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  return `${hours} hours`;
}

const rows = computed(() => [
  { label: 'Storms expire after', full: false, value: `${expiryText(props.limits.stormInactivityHours)} of inactivity` },
  { label: 'Clouds per Storm', full: isFull(props.usage?.clouds, props.limits.maxQuestionsPerStorm), value: withUse(props.usage?.clouds, props.limits.maxQuestionsPerStorm) },
  { label: 'Audience per Storm', full: isFull(props.usage?.audience ?? undefined, props.limits.maxAudiencePerStorm), value: withUse(props.usage?.audience ?? undefined, props.limits.maxAudiencePerStorm) },
  { label: 'Active Storms', full: isFull(props.usage?.activeStorms, props.limits.maxActiveStorms), value: withUse(props.usage?.activeStorms, props.limits.maxActiveStorms) },
]);
</script>

<template>
  <dl class="limits">
    <div v-for="row in rows" :key="row.label" class="limit-row">
      <dt>{{ row.label }}</dt>
      <dd :class="{ full: row.full }">{{ row.value }}<span v-if="row.full" class="sr-only"> (limit reached)</span></dd>
    </div>
  </dl>
</template>

<style>
.limits { margin: 12px 0 0; }
.limit-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .92rem; }
.limit-row:last-child { border-bottom: 0; }
.limit-row dt { color: var(--text-muted); }
.limit-row dd { margin: 0; font-weight: 600; text-align: right; }
.limit-row dd.full { color: var(--danger); }
</style>
