<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import QuestionResults from './QuestionResults.vue';
import type { ClosedQuestion } from '@/shared/types';

const props = defineProps<{ slides: ClosedQuestion[]; large?: boolean; showNav?: boolean }>();

const track = ref<HTMLElement | null>(null);
const slide = ref(0);

function goTo(i: number) {
  const el = track.value;
  if (!el || !props.slides.length) return;
  const next = Math.max(0, Math.min(props.slides.length - 1, i));
  slide.value = next;
  el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
}

function onScroll() {
  const el = track.value;
  if (!el || !el.clientWidth) return;
  slide.value = Math.round(el.scrollLeft / el.clientWidth);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') goTo(slide.value - 1);
  if (e.key === 'ArrowRight') goTo(slide.value + 1);
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="carousel" :class="{ large }" aria-roledescription="carousel" aria-label="Results">
    <div v-if="slides.length === 0" class="card state"><h2>No questions to show</h2></div>
    <div v-else>
      <div ref="track" class="carousel-track" @scroll.passive="onScroll">
        <article v-for="(q, qi) in slides" :key="q.id" class="carousel-slide">
          <div class="card slide-card">
            <div class="slide-eyebrow">Question {{ qi + 1 }}</div>
            <h2 class="slide-title">{{ q.prompt }}</h2>
            <QuestionResults :question="q" :tally="q.tally" :large="large" />
          </div>
        </article>
      </div>
      <div v-if="showNav !== false" class="carousel-nav">
        <button class="btn sm" :disabled="slide === 0" aria-label="Previous question" @click="goTo(slide - 1)">&lsaquo; Prev</button>
        <button class="btn sm" :disabled="slide === slides.length - 1" aria-label="Next question" @click="goTo(slide + 1)">Next &rsaquo;</button>
      </div>
    </div>
  </section>
</template>
