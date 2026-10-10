<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { lightClean } from '@/lib/wordCloud';

// The server refuses words over 30 characters, so each word is cut to that here (the input itself stays roomy so a long paste arrives whole).
const MAX_WORD = 30;
const props = defineProps<{ max: number; initial: string[]; busy: boolean }>();
const emit = defineEmits<{ send: [words: string[]] }>();

const words = ref<string[]>([...props.initial]);
const draft = ref('');
const root = ref<HTMLElement | null>(null);
const sendButton = ref<HTMLButtonElement | null>(null);
const full = computed(() => words.value.length >= props.max);
watch(() => props.initial, (next) => (words.value = [...next]));

// Adds every comma-separated part of the draft as its own word, stopping at the limit.
function add() {
  const parts = draft.value.split(/[,\n]/).map((p) => Array.from(lightClean(p)).slice(0, MAX_WORD).join('').trim()).filter(Boolean);
  draft.value = '';
  const hadFocus = !!root.value && root.value.contains(document.activeElement);
  for (const word of parts) {
    if (full.value) break;
    if (!words.value.includes(word)) words.value.push(word);
  }
  // The input is disabled once the list is full, which would drop keyboard focus: hand it to Send instead.
  if (full.value && hadFocus) nextTick(() => sendButton.value?.focus());
}
function onInput() {
  if (/[,\n]/.test(draft.value)) add();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    add();
  } else if (e.key === 'Backspace' && !draft.value) {
    words.value.pop();
  }
}
function send() {
  add();
  if (words.value.length) emit('send', [...words.value]);
}
</script>

<template>
  <div ref="root" class="words-input">
    <ul class="word-chips" aria-label="Your words">
      <li v-for="w in words" :key="w" class="word-chip">
        {{ w }}
        <button type="button" :aria-label="`Remove ${w}`" @click="words = words.filter((x) => x !== w)">&times;</button>
      </li>
    </ul>
    <div class="words-row">
      <input
        v-model="draft" class="input" type="text" maxlength="200" :disabled="full || busy" autocomplete="off" autocapitalize="off"
        :placeholder="full ? 'That is all your words' : 'Type a word, then Enter'" aria-label="A word to add" @keydown="onKey" @input="onInput"
      />
      <button type="button" class="btn add-word" :disabled="full || busy || !draft.trim()" @click="add">Add</button>
    </div>
    <p class="hint words-count">{{ words.length }} of {{ max }} {{ max === 1 ? 'word' : 'words' }}</p>
    <p v-if="full" class="hint" role="status">That is all your words</p>
    <button ref="sendButton" type="button" class="btn primary lg send-words" :disabled="busy || (!words.length && !draft.trim())" @click="send">Send</button>
  </div>
</template>
