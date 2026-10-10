<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AdminSession } from '@/lib/adminRequest';
import type { PresenterStore } from '@/composables/usePresenter';
import { parseHexColor } from '@/lib/color';
import LicenseLimitsList from '@/components/LicenseLimitsList.vue';

const props = defineProps<{ store: PresenterStore }>();
const emit = defineEmits<{ deleted: []; duplicated: [copy: AdminSession] }>();

const DEFAULT_SWATCH = '#0b1120';
const background = computed(() => props.store.resultsBackground.value);
const nameText = ref<string | null>(null);
const shownName = computed(() => nameText.value ?? props.store.storm.value?.name ?? '');

function saveName() {
  if (nameText.value === null) return;
  const next = nameText.value.trim();
  nameText.value = null;
  if (next !== (props.store.storm.value?.name ?? '')) void props.store.setName(next);
}

const typed = ref<string | null>(null);
const hexText = computed(() => typed.value ?? background.value ?? '');
const hexInvalid = computed(() => typed.value !== null && typed.value.trim() !== '' && !parseHexColor(typed.value));

function saveColor(value: string) {
  const color = parseHexColor(value);
  if (!color) return;
  typed.value = null;
  if (color !== background.value) void props.store.setResultsBackground(color);
}

async function duplicate() {
  const copy = await props.store.duplicateStorm();
  if (copy) emit('duplicated', copy);
}

function resetColor() {
  typed.value = null;
  void props.store.setResultsBackground(null);
}
</script>

<template>
  <div>
    <div class="card" style="margin-bottom: 16px">
      <div class="card-title">Storm name</div>
      <label class="sr-only" for="storm-name">Storm name</label>
      <input
        id="storm-name" class="input" type="text" maxlength="80" placeholder="Give this Storm a name"
        :value="shownName" @input="nameText = ($event.target as HTMLInputElement).value" @change="saveName" @keydown.enter="saveName"
      />
      <p class="muted" style="font-size: .82rem; margin-top: 8px">Only you see the name. It helps you find this Storm in Your Storms.</p>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <div class="card-title">Results screen</div>
      <div class="toolbar">
        <button class="btn primary" @click="store.setConnect(!store.showConnect.value)">
          {{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}
        </button>
      </div>
      <div class="bg-row">
        <label for="results-bg">Background colour</label>
        <input id="results-bg" class="bg-swatch" type="color" :value="background ?? DEFAULT_SWATCH" @change="saveColor(($event.target as HTMLInputElement).value)" />
        <input
          class="input bg-hex" type="text" inputmode="text" maxlength="7" placeholder="#1e293b" aria-label="Background colour as hex" :aria-invalid="hexInvalid"
          :value="hexText" @input="typed = ($event.target as HTMLInputElement).value" @change="saveColor(($event.target as HTMLInputElement).value)" @keydown.enter="saveColor(($event.target as HTMLInputElement).value)"
        />
        <button class="btn" :disabled="!background" @click="resetColor">Reset</button>
      </div>
      <p v-if="hexInvalid" class="muted bg-hint">Use a six-digit hex colour such as #1e293b.</p>
      <p class="muted" style="font-size: .82rem; margin-top: 12px">
        Match the background colour to your slides; text and bars switch between light and dark to stay readable. It applies to the results and join screens.
      </p>
      <p class="muted" style="font-size: .82rem; margin-top: 12px">
        The join screen puts the QR code and live connection count on the results display so latecomers can get connected. It shows automatically
        before the first cloud; use this to bring it back at any time.
      </p>
    </div>

    <div v-if="store.license.value" class="card" style="margin-bottom: 16px">
      <div class="card-title">License</div>
      <p>
        <strong>{{ store.license.value.tier === 'licensed' ? store.license.value.name || 'Licensed' : 'Anonymous' }}</strong>
        <RouterLink to="/license" style="margin-left: 8px; font-size: .85rem">Manage license</RouterLink>
      </p>
      <LicenseLimitsList :limits="store.license.value.limits" />
    </div>

    <div class="card">
      <div class="card-title">Control</div>
      <div class="toolbar">
        <button class="btn" @click="store.resetStorm()">Reset all votes</button>
        <button v-if="store.storm.value?.status !== 'closed'" class="btn" @click="store.closeStorm()">End Storm</button>
        <button v-else class="btn primary" @click="store.reopenStorm()">Reopen Storm</button>
        <button class="btn" @click="duplicate">Duplicate Storm</button>
        <span class="spacer"></span>
        <button class="btn danger" @click="store.deleteStorm().then((ok) => ok && emit('deleted'))">Delete Storm</button>
      </div>
      <p class="muted" style="font-size: .82rem; margin-top: 12px">
        Ending a Storm stops voting but keeps results; reopening resumes it. Duplicating makes a new Storm with the same clouds and background, and no votes. Deleting removes the Storm and all votes permanently.
      </p>
    </div>
  </div>
</template>

<style>
.bg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.bg-row label { font-weight: 600; font-size: .9rem; }
.bg-swatch { width: 42px; height: 34px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
.bg-hex { width: 8.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.bg-hex[aria-invalid='true'] { border-color: var(--danger); }
.bg-hint { font-size: .82rem; margin-top: 6px; color: var(--danger); }
</style>
