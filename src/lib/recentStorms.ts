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
