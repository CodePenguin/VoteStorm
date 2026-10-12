<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api';
import AccountChip from '@/components/AccountChip.vue';
import { useLicense } from '@/composables/useLicense';
import { signedApi } from '@/lib/adminRequest';
import { deleteLicensedStorm, listLicensedStorms, reclaimStorm } from '@/lib/licenseStorms';
import { formatStormCode } from '@/lib/stormCode';
import { presenterLocation } from '@/lib/fragment';
import { agoLabel, inLabel } from '@/lib/relativeTime';
import { forgetStorm, loadRecent, rememberStorm, renameRemembered, type RecentStorm } from '@/lib/recentStorms';
import type { AdminStormData, LicensedStorm } from '@/shared/types';

interface Row extends RecentStorm {
  status?: string;
  clouds?: number;
  lastActiveAt?: number;
  expiresAt?: number;
  unreachable?: boolean;
}

const router = useRouter();
const rows = ref<Row[]>(loadRecent());
const checking = ref(rows.value.length > 0);

async function refresh(row: Row) {
  try {
    const data = await signedApi<AdminStormData>({ stormCode: row.stormCode, secret: row.secret }, 'admin-storm');
    const last = Number(data.storm.last_activity_at ?? data.storm.created_at ?? Date.now());
    Object.assign(row, {
      name: data.storm.name ?? null,
      status: data.storm.status,
      clouds: data.clouds.length,
      lastActiveAt: last,
      expiresAt: last + Number(data.storm.inactivity_hours ?? 24) * 3600000,
      unreachable: false,
    });
    renameRemembered(row.stormCode, row.name);
  } catch (err) {
    // A clock_skew 401 follows a valid signature, so that Storm exists and its secret must be kept.
    if (err instanceof ApiError && err.status === 401 && err.code !== 'clock_skew') {
      // The Storm has expired or been deleted, so there is nothing to open any more.
      forgetStorm(row.stormCode);
      rows.value = rows.value.filter((r) => r.stormCode !== row.stormCode);
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

const open = (row: Row) => router.push(presenterLocation(row.stormCode, row.secret));

function forget(row: Row) {
  forgetStorm(row.stormCode);
  rows.value = rows.value.filter((r) => r.stormCode !== row.stormCode);
}

const license = useLicense();
const remote = ref<LicensedStorm[]>([]);
const errors = ref<Record<string, string>>({});
const busyCode = ref<string | null>(null);

// Storms the license made that this browser has no link for. Derived, so a Storm whose saved secret stops working moves here.
const elsewhere = computed(() => remote.value.filter((s) => !rows.value.some((r) => r.stormCode === s.stormCode)));

// Asked once the loaded license is known to be a real one; the anonymous tier never asks, and a failed lookup changes nothing.
// Not immediate: AccountChip re-checks the license on mount, and a summary left over from an earlier page may be stale.
// This relies on AccountChip's refresh() storing a fresh summary object on every mount of this page, which is what fires the watch.
watch(
  () => license.summary.value,
  async (summary) => {
    if (summary?.tier !== 'licensed') {
      remote.value = [];
      return;
    }
    try {
      const storms = await listLicensedStorms();
      // A license removed or changed while this was in flight has its own lookup.
      if (license.summary.value === summary) remote.value = storms;
    } catch {
      /* the rest of the page does not depend on it */
    }
  },
);

const titleFor = (s: { name: string | null; stormCode: string }) => s.name || `Storm ${formatStormCode(s.stormCode)}`;

async function reclaim(s: LicensedStorm) {
  if (!window.confirm(`Reclaim ${titleFor(s)} on this device? You get a new presenter link. The old presenter link and any results links already shared stop working; the audience link stays the same.`)) return;
  busyCode.value = s.stormCode;
  delete errors.value[s.stormCode];
  try {
    const made = await reclaimStorm(s.stormCode);
    rememberStorm({ stormCode: made.stormCode, secret: made.secret, name: s.name });
    // It is on this device now; if the navigation below fails the row must not stay, its old links are dead.
    remote.value = remote.value.filter((r) => r.stormCode !== s.stormCode);
    await router.push(presenterLocation(made.stormCode, made.secret));
  } catch (err) {
    errors.value[s.stormCode] = (err as Error)?.message || 'Could not reclaim this Storm';
  } finally {
    busyCode.value = null;
  }
}

async function removeElsewhere(s: LicensedStorm) {
  if (!window.confirm(`Delete ${titleFor(s)} with all its clouds and votes? Its presenter, results and audience links stop working. This cannot be undone.`)) return;
  busyCode.value = s.stormCode;
  delete errors.value[s.stormCode];
  try {
    await deleteLicensedStorm(s.stormCode);
    remote.value = remote.value.filter((r) => r.stormCode !== s.stormCode);
  } catch (err) {
    errors.value[s.stormCode] = (err as Error)?.message || 'Could not delete this Storm';
  } finally {
    busyCode.value = null;
  }
}
</script>

<template>
  <main class="container storms-page">
    <AccountChip />
    <RouterLink to="/" class="muted back">&larr; Back</RouterLink>
    <h1>Your Storms</h1>
    <p class="lead">Storms you have created or opened in this browser. Their links are kept here only, so clearing your browser data forgets them.</p>

    <div v-if="rows.length === 0 && elsewhere.length === 0" class="card empty">
      <strong>No Storms on this device yet</strong>
      <p style="margin-bottom: 16px">A Storm appears here once you create or open one.</p>
      <RouterLink to="/" class="btn primary">Create a Storm</RouterLink>
    </div>

    <ul v-else-if="rows.length > 0" class="storm-list" :aria-busy="checking">
      <li v-for="row in rows" :key="row.stormCode" class="card storm-row">
        <div class="storm-main">
          <strong class="storm-title">{{ row.name || `Storm ${formatStormCode(row.stormCode)}` }}</strong>
          <span class="muted storm-meta">
            <span v-if="row.status" class="badge" :class="row.status">{{ row.status }}</span>
            <template v-if="row.clouds !== undefined">{{ row.clouds }} {{ row.clouds === 1 ? 'cloud' : 'clouds' }} &middot; </template>
            <template v-if="row.lastActiveAt">active {{ agoLabel(row.lastActiveAt) }} &middot; expires {{ inLabel(row.expiresAt!) }}</template>
            <template v-else-if="row.unreachable">couldn&rsquo;t check right now</template>
            <template v-else>checking&hellip;</template>
          </span>
          <span class="muted storm-code">Storm code {{ formatStormCode(row.stormCode) }}</span>
        </div>
        <div class="storm-actions">
          <button class="btn primary sm" @click="open(row)">Open</button>
          <button class="btn sm" :aria-label="`Forget ${row.name || 'Storm ' + formatStormCode(row.stormCode)}`" title="Remove from this list. The Storm itself is not deleted." @click="forget(row)">Forget</button>
        </div>
      </li>
    </ul>

    <section v-if="elsewhere.length" class="elsewhere" aria-labelledby="elsewhere-title">
      <h2 id="elsewhere-title">Not on this device</h2>
      <p class="lead">Storms made with your license that this browser has no link for. Reclaim one to get a new presenter link here, or delete it.</p>
      <ul class="storm-list">
        <li v-for="s in elsewhere" :key="s.stormCode" class="card storm-row">
          <div class="storm-main">
            <strong class="storm-title">{{ titleFor(s) }}</strong>
            <span class="muted storm-meta">
              <span class="badge" :class="s.status">{{ s.status }}</span>
              {{ s.cloudCount }} {{ s.cloudCount === 1 ? 'cloud' : 'clouds' }} &middot; active {{ agoLabel(s.lastActivityAt) }} &middot; expires {{ inLabel(s.expiresAt) }}
            </span>
            <span class="muted storm-code">Storm code {{ formatStormCode(s.stormCode) }}</span>
            <p v-if="errors[s.stormCode]" class="alert error row-error" role="alert">{{ errors[s.stormCode] }}</p>
          </div>
          <div class="storm-actions">
            <button class="btn primary sm reclaim" :disabled="busyCode !== null" :aria-label="`Reclaim ${titleFor(s)}`" @click="reclaim(s)">Reclaim</button>
            <button class="btn sm danger delete-elsewhere" :disabled="busyCode !== null" :aria-label="`Delete ${titleFor(s)}`" @click="removeElsewhere(s)">Delete</button>
          </div>
        </li>
      </ul>
    </section>
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
.elsewhere { margin-top: 32px; }
.elsewhere h2 { font-size: 1.15rem; }
.row-error { margin-top: 8px; font-size: .85rem; }
@media (max-width: 520px) { .storm-row { flex-direction: column; align-items: stretch; } .storm-actions { justify-content: flex-end; } }
</style>
