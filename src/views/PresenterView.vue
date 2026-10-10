<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type * as Ably from 'ably';
import { ApiError } from '@/api';
import { subscribeStorm } from '@/composables/useStormChannel';
import { usePresenter } from '@/composables/usePresenter';
import { blankForm, formFromCloud, statusLabel } from '@/lib/presenter';
import type { AdminSession } from '@/lib/adminRequest';
import { createStorm as makeStorm } from '@/lib/createStorm';
import { fragmentFor, presenterLocation, readFragment } from '@/lib/fragment';
import { forgetStorm, rememberStorm } from '@/lib/recentStorms';
import { formatStormCode, normalizeStormCode } from '@/lib/stormCode';
import { useDialogFocus } from '@/composables/useDialogFocus';
import type { AdminCloud, CloudForm, CloudPayload } from '@/shared/types';
import BrandMark from '@/components/BrandMark.vue';
import ControlTab from '@/components/presenter/ControlTab.vue';
import PresentPanel from '@/components/presenter/PresentPanel.vue';
import CloudCard from '@/components/presenter/CloudCard.vue';
import CloudFormView from '@/components/presenter/CloudForm.vue';
import ShareTab from '@/components/presenter/ShareTab.vue';

type Tab = 'clouds' | 'storm';
const TABS: Tab[] = ['clouds', 'storm'];

const route = useRoute();
const router = useRouter();
// The Storm code is in the path; the secret and the open tab are after the `#`, which a browser never sends to a server.
const fragment = computed(() => readFragment(route.hash));
const stormCode = computed(() => normalizeStormCode(String(route.params.stormCode ?? '')));
const secret = computed(() => fragment.value.get('k') ?? '');
const session = computed(() => ({ stormCode: stormCode.value, secret: secret.value }));
const hasSession = computed(() => !!stormCode.value && !!secret.value);
const store = usePresenter(session);

function readMode(): 'edit' | 'present' {
  try {
    return localStorage.getItem('votestorm_mode') === 'present' ? 'present' : 'edit';
  } catch {
    return 'edit';
  }
}

const mode = ref<'edit' | 'present'>(readMode());
const hashTab = readFragment(route.hash).get('t') as Tab;
const tab = ref<Tab>(TABS.includes(hashTab) ? hashTab : 'clouds');
const showShare = ref(false);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const form = ref<CloudForm>(blankForm());
const overlay = ref<HTMLElement | null>(null);
// Present mode takes over the page only once there is a Storm to present; until then (loading, no Storm, no key) the page shows as usual.
const presenting = computed(() => mode.value === 'present' && !!store.storm.value);
const overlayOpen = computed(() => presenting.value && showForm.value);
const stormName = computed(() => {
  const storm = store.storm.value;
  return storm ? storm.name || `Storm ${formatStormCode(storm.storm_code)}` : '';
});
// After the edit overlay closes, focus goes back to whatever opened it; when that is gone (the phone's Controls sheet
// closed as the overlay opened) or a shortcut opened it, to Edit cloud on the rail, the collapsed dock's handle, or the
// Controls button on a phone.
const panel = ref<{ $el: HTMLElement } | null>(null);
useDialogFocus(overlay, overlayOpen, () => panel.value?.$el.querySelector<HTMLElement>('.rail .edit-cloud, .dock-handle, .bar-controls') ?? null);
let ably: Ably.Realtime | null = null;

function setMode(next: 'edit' | 'present') {
  mode.value = next;
  if (next === 'present') showForm.value = false;
  try {
    localStorage.setItem('votestorm_mode', next);
  } catch {
    /* storage unavailable */
  }
}

function exitPresent() {
  setMode('edit');
  if (tab.value !== 'clouds') setTab('clouds');
}

function setTab(next: Tab) {
  tab.value = next;
  void router.replace({ path: route.path, hash: fragmentFor({ k: secret.value, t: next }) });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') showShare.value = false;
}

function openAddForm() {
  editingId.value = null;
  form.value = blankForm();
  showForm.value = true;
}

function cancelForm() {
  showForm.value = false;
  editingId.value = null;
  form.value = blankForm();
}

function startEdit(q: AdminCloud) {
  form.value = formFromCloud(q);
  editingId.value = q.id;
  showForm.value = true;
  setTab('clouds');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Edit cloud in Present mode: the form opens over the stage for the live cloud, which stays live. */
function startEditPresent() {
  const q = store.currentQ.value;
  if (!q) return;
  form.value = formFromCloud(q);
  editingId.value = q.id;
  showForm.value = true;
}

async function save(payload: CloudPayload) {
  if (await store.saveCloud(payload, editingId.value)) cancelForm();
}

async function createStorm() {
  try {
    const created = await makeStorm();
    await router.push(presenterLocation(created.stormCode, created.secret));
  } catch (e) {
    store.error.value = (e as Error)?.message || 'Something went wrong';
  }
}

async function openCopy(copy: AdminSession) {
  await router.push(presenterLocation(copy.stormCode, copy.secret));
  setTab('clouds');
}

// Counts the loads started, so a slow answer for a Storm the link no longer points at is dropped.
let loadId = 0;

async function init() {
  if (!hasSession.value) return;
  const mine = ++loadId;
  const code = stormCode.value;
  const key = secret.value;
  try {
    await store.load();
  } catch (e) {
    if (mine !== loadId) return;
    // A clock_skew 401 comes only after a valid signature, so the Storm exists and the secret is still needed.
    if (e instanceof ApiError && e.status === 401 && e.code !== 'clock_skew') forgetStorm(code);
    store.error.value = (e as Error)?.message || 'Something went wrong';
    return;
  }
  if (mine !== loadId) return;
  rememberStorm({ stormCode: code, secret: key, name: store.storm.value!.name ?? null });
  ably?.close();
  ably = subscribeStorm(store.storm.value!.storm_code, {
    tally: (data) => store.onTally(data),
    state: () => store.safeLoad(),
  });
}

// The link can change under this page (browser Back after Duplicate, or opening another Storm), so everything shown and
// every call signed must follow it: drop the old Storm and its live connection, then load the one the link now names.
watch([stormCode, secret], () => {
  loadId++;
  // A form left open (the edit overlay included) belongs to the old Storm's cloud: never show it over the next one.
  cancelForm();
  store.reset();
  ably?.close();
  ably = null;
  void init();
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
  return init();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  loadId++;
  ably?.close();
});
</script>

<template>
  <div class="presenter-page">
    <header v-if="!presenting" class="app-header">
      <div class="container">
        <RouterLink class="brand" to="/">
          <BrandMark />
        </RouterLink>
        <span class="spacer"></span>
        <div v-if="store.storm.value" class="seg" role="group" aria-label="Presenter mode">
          <button :class="{ on: mode === 'edit' }" :aria-pressed="mode === 'edit'" @click="setMode('edit')">Edit</button>
          <button :class="{ on: mode === 'present' }" :aria-pressed="mode === 'present'" @click="setMode('present')">Present</button>
        </div>
        <button v-if="store.storm.value" class="icon-btn" aria-label="Share: audience and results links" title="Share links and QR codes" @click="showShare = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" /></svg>
        </button>
        <span v-if="store.storm.value" class="badge" :class="store.storm.value.status">
          <span class="dot" :class="{ pulse: store.storm.value.status === 'active' }"></span>
          <span>{{ statusLabel(store.storm.value.status) }}</span>
        </span>
      </div>
    </header>

    <div v-if="showShare && store.storm.value" class="modal-backdrop" @click.self="showShare = false">
      <div class="card modal wide" role="dialog" aria-modal="true" aria-label="Share">
        <div class="share-head">
          <h2>Share</h2>
          <button class="btn sm" @click="showShare = false">Close</button>
        </div>
        <ShareTab :storm-code="store.storm.value.storm_code" :results-key="store.resultsKey.value" @copy-failed="store.error.value = 'Could not copy automatically. Press and hold the link to copy it.'" />
      </div>
    </div>

    <PresentPanel
      v-if="presenting" ref="panel"
      :store="store" :editing="showForm" :storm-name="stormName" @edit="startEditPresent" @exit="exitPresent" @close-edit="cancelForm"
    />
    <div v-if="overlayOpen" class="present-overlay">
      <div ref="overlay" class="card present-dialog" role="dialog" aria-modal="true" aria-label="Edit cloud" tabindex="-1">
        <div v-if="store.error.value" class="alert error" role="alert" style="margin-bottom: 12px">Couldn't complete that: {{ store.error.value }}</div>
        <CloudFormView :key="editingId ?? 'new'" v-model="form" :editing="editingId !== null" @save="save" @cancel="cancelForm" />
      </div>
    </div>

    <main v-if="!presenting" class="container presenter-main">
      <h1 class="sr-only">Presenter</h1>
      <div v-if="store.error.value" class="alert error" style="margin-bottom: 16px">Couldn't complete that: {{ store.error.value }}</div>

      <div v-if="!stormCode" class="card empty">
        <strong>No Storm yet</strong>
        <p style="margin-bottom: 16px">Create a Storm to start adding clouds.</p>
        <button class="btn primary" @click="createStorm">Create a new Storm</button>
        <p style="margin-top: 16px"><RouterLink to="/storms">Your Storms</RouterLink></p>
      </div>

      <div v-else-if="!secret" class="card empty">
        <strong>This link is missing its key</strong>
        <p>Open the full presenter link, or find the Storm under <RouterLink to="/storms">Your Storms</RouterLink>.</p>
      </div>

      <div v-else-if="store.storm.value">
        <div>
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" :class="{ on: tab === 'clouds' }" :aria-selected="tab === 'clouds'" @click="setTab('clouds')">
              Clouds <span class="muted">({{ store.clouds.value.length }})</span>
            </button>
            <button class="tab" role="tab" :class="{ on: tab === 'storm' }" :aria-selected="tab === 'storm'" @click="setTab('storm')">Control</button>
          </div>

          <div v-show="tab === 'clouds'" role="tabpanel">
            <div class="section-head" style="margin-top: 0">
              <h2>Clouds</h2>
              <span class="section-actions">
                <button class="btn primary" @click="showForm ? cancelForm() : openAddForm()">{{ showForm ? 'Cancel' : '+ Add cloud' }}</button>
                <button v-if="store.storm.value.current_cloud_id" class="btn" @click="setMode('present')">Back to presenting</button>
              </span>
            </div>

            <CloudFormView v-if="showForm" :key="editingId ?? 'new'" v-model="form" :editing="editingId !== null" @save="save" @cancel="cancelForm" />

            <div v-if="store.clouds.value.length === 0 && !showForm" class="card empty">
              <strong>No clouds yet</strong>
              <p>Add your first cloud to get started.</p>
            </div>

            <div class="stack">
              <CloudCard
                v-for="(q, index) in store.clouds.value" :key="q.id" :q="q" :index="index" :count="store.clouds.value.length"
                :is-live="q.id === store.storm.value.current_cloud_id" :store="store" @edit="startEdit"
              />
            </div>
          </div>

          <div v-show="tab === 'storm'" role="tabpanel">
            <ControlTab :store="store" @deleted="router.push('/presenter')" @duplicated="openCopy" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
.presenter-page { flex: 1; display: flex; flex-direction: column; }
.modal.wide { max-width: 640px; text-align: left; max-height: calc(100vh - 40px); overflow-y: auto; }
.share-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.presenter-main { flex: 1; padding-top: 28px; padding-bottom: 32px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
.tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 10px 16px; font: inherit; font-weight: 600; color: var(--text-muted); cursor: pointer; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.tab:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: -3px; border-radius: 6px; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 32px 0 14px; }
.section-head h2 { font-size: 1.15rem; }
.section-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.present-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(15,23,42,.45); display: grid; place-items: center; padding: 16px; }
.present-dialog { width: min(720px, 100%); max-height: calc(100dvh - 32px); overflow-y: auto; }
/* The form is its own card; inside the dialog card it should not draw a second frame. */
.present-dialog .cloud-form { margin: 0 !important; padding: 0; border: 0; box-shadow: none; background: none; }
.cloud { padding: 18px 20px; }
.cloud.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
.q-head { display: flex; align-items: flex-start; gap: 12px; }
.q-num { width: 28px; height: 28px; border-radius: 8px; background: var(--surface-2); color: var(--text-muted); font-size: .85rem; font-weight: 700; display: grid; place-items: center; flex: none; }
.q-prompt { font-weight: 600; font-size: 1.02rem; }
.q-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
.q-setup { margin-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; font-size: .85rem; }
.chip.correct { color: var(--success); border-color: var(--success); font-weight: 600; }
.q-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.empty { text-align: center; padding: 36px 20px; color: var(--text-muted); }
.empty strong { display: block; color: var(--text); margin-bottom: 4px; }
.empty p a { text-decoration: underline; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px; background: var(--surface-2); }
.seg button { border: 0; background: transparent; color: var(--text-muted); font: inherit; font-size: .82rem; font-weight: 700; padding: 5px 14px; border-radius: 999px; cursor: pointer; }
.seg button.on { background: var(--accent); color: var(--accent-contrast); }
@media (max-width: 420px) { .presenter-page .app-header .container { gap: 8px; } }
</style>
