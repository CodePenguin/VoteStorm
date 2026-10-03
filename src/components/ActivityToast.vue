<script setup lang="ts">
import { activity, dismissActivity } from '@/composables/useActivity';
</script>

<template>
  <div class="activity-region" role="status" aria-live="polite">
    <div v-if="activity" class="activity-toast" :class="activity.kind">
      <span v-if="activity.kind === 'working'" class="spinner" aria-hidden="true"></span>
      <svg v-else-if="activity.kind === 'done'" class="activity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      <svg v-else class="activity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
      <span class="activity-text">{{ activity.message }}</span>
      <button v-if="activity.kind === 'error'" class="activity-close" aria-label="Dismiss" @click="dismissActivity">&times;</button>
    </div>
  </div>
</template>

<style>
.activity-region { position: fixed; left: 0; right: 0; bottom: 20px; z-index: 60; display: flex; justify-content: center; padding: 0 16px; pointer-events: none; }
.activity-toast {
  display: inline-flex; align-items: center; gap: 10px; max-width: 520px; padding: 11px 16px; border-radius: 999px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: 0 6px 24px rgba(15, 23, 42, .18);
  font-size: .92rem; font-weight: 600; pointer-events: auto;
}
.activity-toast.done { color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
.activity-toast.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); border-radius: var(--radius); }
.activity-icon { width: 18px; height: 18px; flex: none; }
.activity-text { overflow-wrap: anywhere; }
.activity-close { appearance: none; background: none; border: 0; color: inherit; font-size: 1.3rem; line-height: 1; cursor: pointer; padding: 0 2px; }
.spinner { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 2.5px solid var(--border); border-top-color: var(--accent); animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
