import { ref } from 'vue';
import { api } from '@/api';
import { clearStoredLicense, getStoredLicense, setStoredLicense } from '@/licenseStorage';
import type { LicenseSummary } from '@/shared/types';

// Shared across the app: the landing page, presenter and license screen all read the same state.
const hasToken = ref(!!getStoredLicense());
const summary = ref<LicenseSummary | null>(null);
const error = ref<string | null>(null);
// Why the last attempt to load a license failed. Kept apart from `error` so a page refresh cannot wipe it.
const activateError = ref<string | null>(null);
const busy = ref(false);

const message = (e: unknown) => (e as Error)?.message || 'Something went wrong';

async function refresh() {
  busy.value = true;
  hasToken.value = !!getStoredLicense();
  try {
    summary.value = await api<LicenseSummary>('license-status');
    error.value = null;
  } catch (e) {
    // A saved license that no longer validates (expired, wrong issuer) must be removable.
    summary.value = null;
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

/** Validates a pasted or linked token with the server, and only keeps it if it is good. */
async function activate(token: string): Promise<boolean> {
  const jwt = token.trim();
  if (!jwt) {
    activateError.value = 'Paste a license first.';
    return false;
  }
  busy.value = true;
  activateError.value = null;
  try {
    const result = await api<LicenseSummary>('license-status', {
      headers: { authorization: `Bearer ${jwt}` },
      activity: { working: 'Checking license\u2026', done: 'License activated' },
    });
    setStoredLicense(jwt);
    hasToken.value = true;
    summary.value = result;
    error.value = null;
    return true;
  } catch (e) {
    activateError.value = message(e);
    return false;
  } finally {
    busy.value = false;
  }
}

async function remove() {
  clearStoredLicense();
  activateError.value = null;
  await refresh();
}

export function useLicense() {
  return { hasToken, summary, error, activateError, busy, refresh, activate, remove };
}

/** Picks a license out of a `#licenseJwt=...` link and removes it from the address bar. Returns it, or null. */
export function takeLicenseFromHash(): string | null {
  const match = window.location.hash.match(/^#licenseJwt=(.+)$/);
  if (!match) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
