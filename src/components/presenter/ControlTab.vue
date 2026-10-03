<script setup lang="ts">
import type { PresenterStore } from '@/composables/usePresenter';
import LicenseLimitsList from '@/components/LicenseLimitsList.vue';

defineProps<{ store: PresenterStore }>();
const emit = defineEmits<{ deleted: [] }>();
</script>

<template>
  <div>
    <div class="card" style="margin-bottom: 16px">
      <div class="card-title">Results screen</div>
      <div class="toolbar">
        <button class="btn primary" @click="store.setConnect(!store.showConnect.value)">
          {{ store.showConnect.value ? 'Hide join screen' : 'Show join screen' }}
        </button>
      </div>
      <p class="muted" style="font-size: .82rem; margin-top: 12px">
        The join screen puts the QR code and live connection count on the results display so latecomers can get connected. It shows automatically
        before the first question; use this to bring it back at any time.
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
        <button class="btn" @click="store.resetRoom()">Reset all votes</button>
        <button v-if="store.room.value?.status !== 'closed'" class="btn" @click="store.closeRoom()">Close room</button>
        <button v-else class="btn primary" @click="store.reopenRoom()">Reopen room</button>
        <span class="spacer"></span>
        <button class="btn danger" @click="store.deleteRoom().then((ok) => ok && emit('deleted'))">Delete room</button>
      </div>
      <p class="muted" style="font-size: .82rem; margin-top: 12px">
        Closing stops voting but keeps results; reopening resumes it. Deleting removes the room and all votes permanently.
      </p>
    </div>
  </div>
</template>
