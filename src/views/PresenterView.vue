<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type * as Ably from 'ably';
import { api } from '@/api';
import { subscribeStorm } from '@/composables/useStormChannel';
import { usePresenter } from '@/composables/usePresenter';
import { blankForm, formFromQuestion, statusLabel } from '@/lib/presenter';
import type { AdminQuestion, QuestionForm, QuestionPayload } from '@/shared/types';
import BrandMark from '@/components/BrandMark.vue';
import ControlTab from '@/components/presenter/ControlTab.vue';
import PresentPanel from '@/components/presenter/PresentPanel.vue';
import QuestionCard from '@/components/presenter/QuestionCard.vue';
import QuestionFormView from '@/components/presenter/QuestionForm.vue';
import ShareTab from '@/components/presenter/ShareTab.vue';

type Tab = 'questions' | 'storm';
const TABS: Tab[] = ['questions', 'storm'];

const route = useRoute();
const router = useRouter();
const adminKey = computed(() => String(route.params.adminKey ?? ''));
const store = usePresenter(adminKey);

function readMode(): 'edit' | 'present' {
  try {
    return localStorage.getItem('votestorm_mode') === 'present' ? 'present' : 'edit';
  } catch {
    return 'edit';
  }
}

const mode = ref<'edit' | 'present'>(readMode());
const hashTab = route.hash.slice(1) as Tab;
const tab = ref<Tab>(TABS.includes(hashTab) ? hashTab : 'questions');
const showShare = ref(false);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const form = ref<QuestionForm>(blankForm());
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

function setTab(next: Tab) {
  tab.value = next;
  history.replaceState(null, '', '#' + next);
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

function startEdit(q: AdminQuestion) {
  form.value = formFromQuestion(q);
  editingId.value = q.id;
  showForm.value = true;
  setTab('questions');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save(payload: QuestionPayload) {
  if (await store.saveQuestion(payload, editingId.value)) cancelForm();
}

async function createStorm() {
  try {
    const data = await api<{ adminKey: string }>('create-storm', { method: 'POST' });
    await router.push(`/presenter/${data.adminKey}`);
    await init();
  } catch (e) {
    store.error.value = (e as Error)?.message || 'Something went wrong';
  }
}

async function init() {
  if (!adminKey.value) return;
  try {
    await store.load();
  } catch (e) {
    store.error.value = (e as Error)?.message || 'Something went wrong';
    return;
  }
  ably?.close();
  ably = subscribeStorm(store.storm.value!.storm_code, {
    tally: (data) => store.onTally(data),
    state: () => store.safeLoad(),
  });
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  return init();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  ably?.close();
});
</script>

<template>
  <div class="presenter-page">
    <header class="app-header">
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

    <main class="container presenter-main">
      <div v-if="store.error.value" class="alert error" style="margin-bottom: 16px">Couldn't complete that: {{ store.error.value }}</div>

      <div v-if="!adminKey" class="card empty">
        <strong>No Storm yet</strong>
        <p style="margin-bottom: 16px">Create a Storm to start adding questions.</p>
        <button class="btn primary" @click="createStorm">Create a new Storm</button>
      </div>

      <div v-else-if="store.storm.value">
        <PresentPanel v-show="mode === 'present'" :store="store" />

        <div v-show="mode === 'edit'">
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" :class="{ on: tab === 'questions' }" :aria-selected="tab === 'questions'" @click="setTab('questions')">
              Questions <span class="muted">({{ store.questions.value.length }})</span>
            </button>
            <button class="tab" role="tab" :class="{ on: tab === 'storm' }" :aria-selected="tab === 'storm'" @click="setTab('storm')">Control</button>
          </div>

          <div v-show="tab === 'questions'" role="tabpanel">
            <div class="section-head" style="margin-top: 0">
              <h2>Questions</h2>
              <button class="btn primary" @click="showForm ? cancelForm() : openAddForm()">{{ showForm ? 'Cancel' : '+ Add question' }}</button>
            </div>

            <QuestionFormView v-if="showForm" :key="editingId ?? 'new'" v-model="form" :editing="editingId !== null" @save="save" @cancel="cancelForm" />

            <div v-if="store.questions.value.length === 0 && !showForm" class="card empty">
              <strong>No questions yet</strong>
              <p>Add your first question to get started.</p>
            </div>

            <div class="stack">
              <QuestionCard
                v-for="(q, index) in store.questions.value" :key="q.id" :q="q" :index="index" :count="store.questions.value.length"
                :is-live="q.id === store.storm.value.current_question_id" :store="store" @edit="startEdit"
              />
            </div>
          </div>

          <div v-show="tab === 'storm'" role="tabpanel">
            <ControlTab :store="store" @deleted="router.push('/presenter')" />
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
.question { padding: 18px 20px; }
.question.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
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
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px; background: var(--surface-2); }
.seg button { border: 0; background: transparent; color: var(--text-muted); font: inherit; font-size: .82rem; font-weight: 700; padding: 5px 14px; border-radius: 999px; cursor: pointer; }
.seg button.on { background: var(--accent); color: var(--accent-contrast); }
</style>
