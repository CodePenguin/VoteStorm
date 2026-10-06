<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useLicense } from '@/composables/useLicense';
import type { LicenseLimits } from '@/shared/types';
import LicenseLimitsList from '@/components/LicenseLimitsList.vue';

const license = useLicense();
const pasted = ref('');

onMounted(() => license.refresh());

const isLicensed = computed(() => license.summary.value?.tier === 'licensed');
const expires = computed(() => {
  const at = license.summary.value?.expiresAt;
  return at ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;
});
const limits = computed<LicenseLimits | null>(() => license.summary.value?.limits ?? null);

async function activate() {
  if (await license.activate(pasted.value)) pasted.value = '';
}
</script>

<template>
  <main class="container narrow license-page">
    <RouterLink to="/" class="muted back">&larr; Back</RouterLink>
    <h1>License</h1>

    <div v-if="license.error.value" class="alert error" style="margin: 16px 0">
      {{ license.error.value }}
      <button v-if="license.hasToken.value" class="btn sm" style="margin-left: 8px" @click="license.remove()">Remove saved license</button>
    </div>

    <div v-if="license.summary.value" class="card" style="margin-top: 16px">
      <div class="card-title">Current plan</div>
      <h2 class="plan-name">{{ isLicensed ? license.summary.value.name || 'Licensed' : 'Anonymous' }}</h2>
      <p v-if="!isLicensed" class="muted">No license is loaded. Storms use the default limits below.</p>
      <p v-else-if="expires" class="muted">Valid until {{ expires }}</p>
      <LicenseLimitsList v-if="limits" :limits="limits" />
      <div v-if="isLicensed" class="row" style="margin-top: 16px">
        <button class="btn" @click="license.remove()">Remove license</button>
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="card-title">{{ isLicensed ? 'Replace license' : 'Load a license' }}</div>
      <p class="muted" style="margin-bottom: 12px">
        A license is a signed token from whoever runs this VoteStorm server. It sets how long Storms last and how large they can be.
        Paste it below, or open the link you were sent.
      </p>
      <label class="field">
        <span>License</span>
        <textarea v-model="pasted" class="input" rows="4" placeholder="eyJhbGciOi..." spellcheck="false" autocomplete="off"></textarea>
      </label>
      <div v-if="license.activateError.value" class="alert error" style="margin-top: 12px">{{ license.activateError.value }}</div>
      <div class="row" style="margin-top: 12px">
        <button class="btn primary" :disabled="license.busy.value || !pasted.trim()" @click="activate">Activate license</button>
      </div>
    </div>
  </main>
</template>

<style>
.license-page { padding-top: 28px; padding-bottom: 48px; }
.license-page h1 { margin: 8px 0 0; font-size: 1.6rem; }
.license-page .back { display: inline-block; font-size: .9rem; }
.license-page .plan-name { font-size: 1.3rem; margin-bottom: 4px; }
.license-page textarea.input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8rem; word-break: break-all; }
</style>
