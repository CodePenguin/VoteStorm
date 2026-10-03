<script setup lang="ts">
import { computed } from 'vue';
import type { LicenseLimits } from '@/shared/types';

const props = defineProps<{ limits: LicenseLimits }>();

function expiryText(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  return `${hours} hours`;
}

const rows = computed(() => [
  { label: 'Rooms expire after', value: `${expiryText(props.limits.roomInactivityHours)} of inactivity` },
  { label: 'Questions per room', value: props.limits.maxQuestionsPerRoom ? String(props.limits.maxQuestionsPerRoom) : 'Unlimited' },
  { label: 'Audience per room', value: props.limits.maxAudiencePerRoom ? String(props.limits.maxAudiencePerRoom) : 'Unlimited' },
  { label: 'Active rooms', value: props.limits.maxActiveRooms ? String(props.limits.maxActiveRooms) : 'Unlimited' },
]);
</script>

<template>
  <dl class="limits">
    <div v-for="row in rows" :key="row.label" class="limit-row">
      <dt>{{ row.label }}</dt>
      <dd>{{ row.value }}</dd>
    </div>
  </dl>
</template>

<style>
.limits { margin: 12px 0 0; }
.limit-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: .92rem; }
.limit-row:last-child { border-bottom: 0; }
.limit-row dt { color: var(--text-muted); }
.limit-row dd { margin: 0; font-weight: 600; text-align: right; }
</style>
