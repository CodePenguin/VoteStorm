import type { RouteLocationRaw } from 'vue-router';

// Presenter and results links keep their secret and their state after the `#`, as `#k=...&t=...`. Browsers never
// send the fragment to a server, so none of it reaches logs, referrers or redirects.

type Values = Record<string, string | number | null | undefined>;

/** The `key=value` pairs of a location hash, with or without the leading `#`. */
export function readFragment(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** `#k=...&q=...` from the values that are set (null and undefined are left out). Empty if none are. */
export function fragmentFor(values: Values): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '') params.set(name, String(value));
  }
  const text = params.toString();
  return text ? `#${text}` : '';
}

export const presenterLocation = (stormCode: string, secret?: string | null, tab?: string | null): RouteLocationRaw => ({
  path: `/presenter/${stormCode}`,
  hash: fragmentFor({ k: secret, t: tab }),
});

/** A link anyone can open to watch a Storm's results, optionally pinned to one question. */
export const resultsUrl = (origin: string, resultsKey: string, questionId?: number | null) =>
  `${origin}/results${fragmentFor({ k: resultsKey, q: questionId })}`;
