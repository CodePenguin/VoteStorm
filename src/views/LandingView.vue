<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';

const router = useRouter();
const creating = ref(false);
const error = ref<string | null>(null);
const licenseProblem = ref(false);

async function createStorm() {
  creating.value = true;
  error.value = null;
  licenseProblem.value = false;
  try {
    const data = await api<{ adminKey: string }>('create-storm', { method: 'POST' });
    await router.push(`/presenter/${data.adminKey}`);
  } catch (err) {
    error.value = (err as Error)?.message || 'Something went wrong';
    licenseProblem.value = (err as { code?: string }).code === 'license_invalid';
    creating.value = false;
  }
}

const steps = [
  { title: 'Create', text: 'Spin up a Storm and add multiple-choice or rating questions.' },
  { title: 'Share', text: 'Audience members open one link and vote anonymously on any device.' },
  { title: 'Watch live', text: 'Advance questions and show results on a big screen as votes arrive.' },
];
</script>

<template>
  <main class="hero">
    <div class="container">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M8.5 2 2 13.2h4.6L5.6 22 12 10.6H7.6L8.5 2Z" fill="currentColor" /><path d="M15 7h7M15 12h5M15 17h3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </span>
      <h1>VoteStorm</h1>
      <p class="lead">Live polling for presentations, meetings and classrooms. Each session is a <strong>Storm</strong>: add your questions, share one link, and watch the answers arrive as your audience votes from their own devices.</p>
      <button class="btn primary lg" :disabled="creating" @click="createStorm">{{ creating ? 'Creating…' : 'Create a Storm' }}</button>
      <p v-if="error" class="alert error landing-error">
        {{ error }}
        <RouterLink v-if="licenseProblem" to="/license">Manage license</RouterLink>
      </p>

      <div class="steps">
        <div v-for="(step, i) in steps" :key="step.title" class="card step">
          <div class="num">{{ i + 1 }}</div>
          <h3>{{ step.title }}</h3>
          <p>{{ step.text }}</p>
        </div>
      </div>
    </div>
  </main>
</template>

<style>
.hero { flex: 1; display: flex; align-items: center; padding: 48px 0; }
.hero .container { text-align: center; }
.hero .logo { width: 56px; height: 56px; border-radius: 16px; margin-bottom: 20px; }
.hero .logo svg { width: 38px; height: 38px; }
.hero h1 { font-size: clamp(2rem, 6vw, 3rem); }
.hero .lead { font-size: 1.1rem; color: var(--text-muted); margin: 14px auto 28px; max-width: 500px; text-wrap: balance; }
.hero .lead strong { color: var(--text); }
.landing-error { margin: 20px auto 0; max-width: 420px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 56px; text-align: left; }
.step .num { width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-weight: 700; font-size: .85rem; margin-bottom: 10px; }
.step h3 { font-size: 1rem; margin-bottom: 4px; }
.step p { font-size: .9rem; color: var(--text-muted); }
@media (max-width: 640px) { .steps { grid-template-columns: 1fr; } }
</style>
