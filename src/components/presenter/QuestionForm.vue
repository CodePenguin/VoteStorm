<script setup lang="ts">
import { computed, ref } from 'vue';
import { buildQuestionPayload } from '@/lib/presenter';
import type { QuestionForm, QuestionPayload } from '@/shared/types';

const props = defineProps<{ modelValue: QuestionForm; editing: boolean }>();
const emit = defineEmits<{ save: [payload: QuestionPayload]; cancel: [] }>();

const form = computed(() => props.modelValue);
const formError = ref<string | null>(null);

function submit() {
  try {
    formError.value = null;
    emit('save', buildQuestionPayload(form.value));
  } catch (e) {
    formError.value = (e as Error).message;
  }
}
</script>

<template>
  <div class="card" style="margin-bottom: 16px">
    <div class="card-title">{{ editing ? 'Edit question' : 'New question' }}</div>
    <div v-if="formError" class="alert error" style="margin-bottom: 12px">{{ formError }}</div>
    <div class="form-grid">
      <label class="field">
        <span>Type</span>
        <select v-model="form.type" class="input">
          <option value="choice">Choice</option>
          <option value="rating">Rating scale</option>
        </select>
      </label>
      <label class="field">
        <span>Prompt</span>
        <input v-model="form.prompt" class="input" type="text" maxlength="300" placeholder="What would you like to ask?" />
      </label>

      <div v-if="form.type === 'choice'" class="form-grid full">
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

      <div v-else class="form-grid full">
        <label class="field">
          <span>Min</span>
          <input v-model.number="form.scaleMin" class="input" type="number" />
        </label>
        <label class="field">
          <span>Max</span>
          <input v-model.number="form.scaleMax" class="input" type="number" />
        </label>
      </div>

      <label class="check full"><input v-model="form.resultsHidden" type="checkbox" /> Hide results until I show them</label>
    </div>
    <div class="row" style="margin-top: 16px">
      <button class="btn primary" @click="submit">{{ editing ? 'Save changes' : 'Save question' }}</button>
      <button class="btn ghost" @click="emit('cancel')">Cancel</button>
    </div>
  </div>
</template>

<style>
.check { display: flex; align-items: center; gap: 8px; font-size: .92rem; }
</style>
