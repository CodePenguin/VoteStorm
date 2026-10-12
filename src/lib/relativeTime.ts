const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string {
  if (ms < MINUTE) return 'less than a minute';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/** "5 min ago", "3 h ago", "just now". */
export function agoLabel(then: number, now = Date.now()): string {
  const ms = Math.max(0, now - then);
  return ms < MINUTE ? 'just now' : `${span(ms)} ago`;
}

/**
 * When to try again, from a wait in seconds, rounded up so it is never too early: "in under a minute", "in a minute",
 * "in about 12 minutes", "in about an hour", "in about 3 hours", or "later" when the wait is unknown.
 */
export function retryLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 'later';
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return 'in a minute';
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/** "in 5 h", or "expired" once the time has passed. */
export function inLabel(when: number, now = Date.now()): string {
  const ms = when - now;
  return ms <= 0 ? 'expired' : `in ${span(ms)}`;
}
