<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppFooter from './components/AppFooter.vue';
import { takeLicenseFromHash, useLicense } from '@/composables/useLicense';

const router = useRouter();
const license = useLicense();

// A link like /#licenseJwt=<token> activates a license, then shows the result.
onMounted(async () => {
  const token = takeLicenseFromHash();
  if (token) {
    await license.activate(token);
    await router.push('/license');
  }
});
</script>

<template>
  <div class="app-shell">
    <RouterView />
    <AppFooter v-if="!$route.meta.ownFooter" />
  </div>
</template>

<style>
.app-shell { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
.app-shell > :first-child { flex: 1; }
</style>
