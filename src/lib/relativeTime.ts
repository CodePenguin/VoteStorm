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

/** "in 5 h", or "expired" once the time has passed. */
export function inLabel(when: number, now = Date.now()): string {
  const ms = when - now;
  return ms <= 0 ? 'expired' : `in ${span(ms)}`;
}
