<script setup lang="ts">
import { computed, ref } from 'vue';
import MarkdownContent from '@/components/MarkdownContent.vue';
import { buildCloudPayload } from '@/lib/presenter';
import type { CloudForm, CloudPayload } from '@/shared/types';

const props = defineProps<{ modelValue: CloudForm; editing: boolean }>();
const emit = defineEmits<{ save: [payload: CloudPayload]; cancel: [] }>();

const form = computed(() => props.modelValue);
const formError = ref<string | null>(null);
const MAX_BODY = 4000;

function submit() {
  try {
    formError.value = null;
    emit('save', buildCloudPayload(form.value));
  } catch (e) {
    formError.value = (e as Error).message;
  }
}
</script>

<template>
  <div class="card cloud-form" style="margin-bottom: 16px">
    <div class="card-title">{{ editing ? 'Edit cloud' : 'New cloud' }}</div>
    <div v-if="formError" class="alert error" style="margin-bottom: 12px">{{ formError }}</div>
    <div class="form-grid">
      <label class="field full">
        <span>Type</span>
        <select v-model="form.kind" class="input">
          <option value="choice">Choice</option>
          <option value="rating">Rating scale</option>
          <option value="words">Words</option>
          <option value="content">Content</option>
        </select>
      </label>
      <div class="field full">
        <label for="cloud-body"><span class="field-label">Text (markdown)</span></label>
        <textarea id="cloud-body" v-model="form.body" class="input" :maxlength="MAX_BODY" rows="4" placeholder="What would you like to ask or show?"></textarea>
        <div class="form-counter muted">{{ form.body.length }} / {{ MAX_BODY }}</div>
        <div class="form-preview" aria-label="Preview">
          <span class="form-preview-title muted">Preview</span>
          <MarkdownContent :source="form.body || '*Preview*'" />
        </div>
      </div>

      <div v-if="form.kind === 'choice'" class="form-grid full">
        <label class="field full">
          <span>Options (comma separated)</span>
          <input v-model="form.optionsText" class="input" type="text" placeholder="Yes, No, Maybe" />
        </label>
        <label class="field full">
          <span>Correct answer(s), optional (option text, comma separated)</span>
          <input v-model="form.correctText" class="input" type="text" placeholder="Leave blank if there is no right answer" />
        </label>
        <label class="field">
          <span>Live results display</span>
          <select v-model="form.display" class="input">
            <option value="bars">Bar chart</option>
            <option value="donut">Donut chart</option>
          </select>
        </label>
        <label class="check"><input v-model="form.multi" type="checkbox" /> Allow multiple answers</label>
      </div>

      <div v-else-if="form.kind === 'rating'" class="form-grid full">
        <label class="field">
          <span>Min</span>
          <input v-model.number="form.scaleMin" class="input" type="number" />
        </label>
        <label class="field">
          <span>Max</span>
          <input v-model.number="form.scaleMax" class="input" type="number" />
        </label>
      </div>

      <div v-else-if="form.kind === 'words'" class="form-grid full">
        <label class="field">
          <span>Words per person</span>
          <input v-model.number="form.maxWords" class="input" type="number" min="1" max="10" />
        </label>
      </div>

      <label v-if="form.kind !== 'content'" class="check full"><input v-model="form.resultsHidden" type="checkbox" /> Hide results until I show them</label>
    </div>
    <div class="row" style="margin-top: 16px">
      <button class="btn primary" @click="submit">Save cloud</button>
      <button class="btn ghost" @click="emit('cancel')">Cancel</button>
    </div>
  </div>
</template>

<style>
.check { display: flex; align-items: center; gap: 8px; font-size: .92rem; }
.field-label { font-size: .82rem; font-weight: 600; color: var(--text-muted); }
.field textarea.input { resize: vertical; min-height: 6em; font: inherit; }
.form-counter { font-size: .8rem; text-align: right; font-variant-numeric: tabular-nums; }
.form-preview { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; max-height: 16em; overflow: auto; min-width: 0; }
.form-preview-title { display: block; font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
</style>
