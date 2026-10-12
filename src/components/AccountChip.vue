<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useLicense } from '@/composables/useLicense';

const license = useLicense();

onMounted(() => license.refresh());

const problem = computed(() => !!license.error.value);
const label = computed(() => {
  const summary = license.summary.value;
  if (problem.value) return 'License problem';
  if (!summary) return 'License';
  return summary.tier === 'licensed' ? summary.name || 'Licensed' : 'Free';
});
// "2/5": Storms in use out of the allowance. It is what stops "Create a Storm" when full, so it belongs next to the button.
const stormUse = computed(() => {
  const summary = license.summary.value;
  const cap = summary?.limits.maxActiveStorms;
  return cap && summary?.usage ? `${summary.usage.activeStorms}/${cap}` : null;
});
const full = computed(() => {
  const cap = license.summary.value?.limits.maxActiveStorms;
  return !!cap && (license.summary.value?.usage?.activeStorms ?? 0) >= cap;
});
</script>

<template>
  <RouterLink to="/license" class="account-chip" :class="{ problem, full }" :title="stormUse ? `${stormUse} active Storms` : 'License'">
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7" /></svg>
    <span class="account-label">{{ label }}</span>
    <span v-if="stormUse" class="account-use">{{ stormUse }}<span class="sr-only"> active Storms</span></span>
  </RouterLink>
</template>

<style>
.account-chip {
  position: absolute; top: 16px; right: 16px; display: inline-flex; align-items: center; gap: 8px; max-width: calc(100% - 32px);
  padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px; font-size: .88rem; color: var(--text); text-decoration: none;
}
.account-chip:hover { background: var(--accent-soft); }
.account-chip svg { width: 18px; height: 18px; flex: none; }
.account-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-use { font-weight: 600; color: var(--text-muted); }
.account-chip.full .account-use, .account-chip.problem { color: var(--danger); }
@media (max-width: 420px) { .account-label { display: none; } }
</style>
