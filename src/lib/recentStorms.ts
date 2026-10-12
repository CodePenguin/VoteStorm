// Storms this browser has created or opened, so a lost tab or an unrecorded link is easy to get back to. The presenter
// secret is kept here, on the device, and nowhere on the server.

export interface RecentStorm {
  stormCode: string;
  secret: string;
  name: string | null;
  lastOpenedAt: number;
}

const STORAGE_KEY = 'votestorm_recent';
export const MAX_RECENT = 50;

const isEntry = (value: unknown): value is RecentStorm => {
  const e = value as Partial<RecentStorm> | null;
  return (
    !!e && typeof e.secret === 'string' && e.secret.length > 0 && typeof e.stormCode === 'string' &&
    (e.name === null || typeof e.name === 'string') && typeof e.lastOpenedAt === 'number'
  );
};

function save(entries: RecentStorm[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
  } catch {
    /* storage unavailable or full: the list just does not persist */
  }
}

/** Newest first. Anything unreadable is ignored rather than breaking the page. */
export function loadRecent(): RecentStorm[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt) : [];
  } catch {
    return [];
  }
}

/** Adds a Storm, or refreshes it and moves it to the top. */
export function rememberStorm(entry: { stormCode: string; secret: string; name?: string | null }, now = Date.now()) {
  const others = loadRecent().filter((e) => e.stormCode !== entry.stormCode);
  save([{ stormCode: entry.stormCode, secret: entry.secret, name: entry.name ?? null, lastOpenedAt: now }, ...others]);
}

/** Changes what is shown for a Storm without moving it in the list. */
export function renameRemembered(stormCode: string, name: string | null) {
  save(loadRecent().map((e) => (e.stormCode === stormCode ? { ...e, name } : e)));
}

export function forgetStorm(stormCode: string) {
  save(loadRecent().filter((e) => e.stormCode !== stormCode));
}

export interface MergeResult {
  added: number;
  updated: number;
  kept: number;
}

/**
 * Folds Storms from another device into this browser's list. For a Storm both know, the later `lastOpenedAt` wins (a reclaimed
 * key is always the newer one); a timestamp from the future counts as `now`, so it cannot win every later merge. The list stays
 * at the 50 newest. `updated` counts replaced secrets, `kept` the incoming Storms that changed nothing or did not fit.
 */
export function mergeLists(local: RecentStorm[], incoming: RecentStorm[], now: number): { merged: RecentStorm[]; result: MergeResult } {
  const byCode = new Map(local.map((e) => [e.stormCode, e]));
  const outcome = new Map<string, 'added' | 'updated' | 'kept'>();
  for (const raw of incoming) {
    const next = { ...raw, lastOpenedAt: Math.min(raw.lastOpenedAt, now) };
    const have = byCode.get(next.stormCode);
    if (!have) {
      byCode.set(next.stormCode, next);
      outcome.set(next.stormCode, 'added');
    } else if (next.lastOpenedAt > have.lastOpenedAt) {
      byCode.set(next.stormCode, next);
      outcome.set(next.stormCode, next.secret !== have.secret ? 'updated' : 'kept');
    } else {
      outcome.set(next.stormCode, 'kept');
    }
  }
  const merged = [...byCode.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, MAX_RECENT);
  const survivors = new Set(merged.map((e) => e.stormCode));
  const result: MergeResult = { added: 0, updated: 0, kept: 0 };
  for (const [code, what] of outcome) result[survivors.has(code) ? what : 'kept']++;
  return { merged, result };
}

/** `mergeLists` against this browser's saved list. */
export function mergeRecent(incoming: RecentStorm[], now = Date.now()): MergeResult {
  const { merged, result } = mergeLists(loadRecent(), incoming, now);
  save(merged);
  return result;
}
