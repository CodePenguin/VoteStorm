<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '@/api';
import { presenterLocation } from '@/lib/fragment';
import { agoLabel, inLabel } from '@/lib/relativeTime';
import { forgetStorm, loadRecent, renameRemembered, type RecentStorm } from '@/lib/recentStorms';
import type { AdminStormData } from '@/shared/types';

interface Row extends RecentStorm {
  status?: string;
  questions?: number;
  lastActiveAt?: number;
  expiresAt?: number;
  unreachable?: boolean;
}

const router = useRouter();
const rows = ref<Row[]>(loadRecent());
const checking = ref(rows.value.length > 0);

async function refresh(row: Row) {
  try {
    const data = await api<AdminStormData>('admin-storm', { headers: { 'x-admin-key': row.adminKey } });
    const last = Number(data.storm.last_activity_at ?? data.storm.created_at ?? Date.now());
    Object.assign(row, {
      name: data.storm.name ?? null,
      status: data.storm.status,
      questions: data.questions.length,
      lastActiveAt: last,
      expiresAt: last + Number(data.storm.inactivity_hours ?? 24) * 3600000,
      unreachable: false,
    });
    renameRemembered(row.adminKey, row.name);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
      // The Storm has expired or been deleted, so there is nothing to open any more.
      forgetStorm(row.adminKey);
      rows.value = rows.value.filter((r) => r.adminKey !== row.adminKey);
    } else {
      row.unreachable = true;
    }
  }
}

onMounted(async () => {
  const queue = [...rows.value];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) await refresh(row);
    }),
  );
  checking.value = false;
});

const open = (row: Row) => router.push(presenterLocation(row.adminKey));

function forget(row: Row) {
  forgetStorm(row.adminKey);
  rows.value = rows.value.filter((r) => r.adminKey !== row.adminKey);
}
</script>

<template>
  <main class="container storms-page">
    <RouterLink to="/" class="muted back">&larr; Back</RouterLink>
    <h1>Your Storms</h1>
    <p class="lead">Storms you have created or opened in this browser. Their links are kept here only, so clearing your browser data forgets them.</p>

    <div v-if="rows.length === 0" class="card empty">
      <strong>No Storms on this device yet</strong>
      <p style="margin-bottom: 16px">A Storm appears here once you create or open one.</p>
      <RouterLink to="/" class="btn primary">Create a Storm</RouterLink>
    </div>

    <ul v-else class="storm-list" :aria-busy="checking">
      <li v-for="row in rows" :key="row.adminKey" class="card storm-row">
        <div class="storm-main">
          <strong class="storm-title">{{ row.name || `Storm ${row.stormCode}` }}</strong>
          <span class="muted storm-meta">
            <span v-if="row.status" class="badge" :class="row.status">{{ row.status }}</span>
            <template v-if="row.questions !== undefined">{{ row.questions }} {{ row.questions === 1 ? 'question' : 'questions' }} &middot; </template>
            <template v-if="row.lastActiveAt">active {{ agoLabel(row.lastActiveAt) }} &middot; expires {{ inLabel(row.expiresAt!) }}</template>
            <template v-else-if="row.unreachable">couldn&rsquo;t check right now</template>
            <template v-else>checking&hellip;</template>
          </span>
          <span class="muted storm-code">Storm code {{ row.stormCode }}</span>
        </div>
        <div class="storm-actions">
          <button class="btn primary sm" @click="open(row)">Open</button>
          <button class="btn sm" :aria-label="`Forget ${row.name || 'Storm ' + row.stormCode}`" title="Remove from this list. The Storm itself is not deleted." @click="forget(row)">Forget</button>
        </div>
      </li>
    </ul>
  </main>
</template>

<style>
.storms-page { padding-top: 28px; padding-bottom: 48px; }
.storms-page .back { display: inline-block; margin-bottom: 12px; font-size: .9rem; }
.storms-page .lead { color: var(--text-muted); margin: 10px 0 20px; }
.storm-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.storm-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; }
.storm-main { display: grid; gap: 4px; min-width: 0; }
.storm-title { font-size: 1.05rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.storm-meta { font-size: .88rem; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.storm-code { font-size: .78rem; }
.storm-actions { display: flex; gap: 8px; flex: none; }
@media (max-width: 520px) { .storm-row { flex-direction: column; align-items: stretch; } .storm-actions { justify-content: flex-end; } }
</style>
