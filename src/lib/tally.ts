import type { HiddenTally, Question, Tally, VisibleTally } from '@/shared/types';

export const DONUT_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export function emptyTally(totalVotes = 0): VisibleTally {
  return { counts: [], totalVotes };
}

/** The server sends null for "no tally yet" and a counts-less object while results are hidden. */
export function normalizeTally(t: Tally | null | undefined): Tally {
  return t ?? emptyTally();
}

export function isHiddenTally(t: Tally | null | undefined): t is HiddenTally {
  return !!t && 'hidden' in t && t.hidden === true;
}

export function hasCounts(t: Tally | null | undefined): t is VisibleTally {
  return !!t && 'counts' in t;
}

export function countFor(t: VisibleTally, key: number): number {
  return (t.counts as Record<number, number>)[key] ?? 0;
}

export function pctFor(t: VisibleTally, key: number): number {
  const total = t.totalVotes || 0;
  return total ? Math.round((countFor(t, key) / total) * 100) : 0;
}

export function isLeader(t: VisibleTally, key: number): boolean {
  const count = countFor(t, key);
  if (!count) return false;
  return count === Math.max(...Object.values(t.counts as Record<number, number>).map((c) => c || 0));
}

export function ratingValues(q: Pick<Question, 'scaleMin' | 'scaleMax'>): number[] {
  if (q.scaleMin == null || q.scaleMax == null) return [];
  return Array.from({ length: q.scaleMax - q.scaleMin + 1 }, (_, k) => (q.scaleMin as number) + k);
}

/** stroke-dasharray / offset pairs for a 100-unit-circumference donut. */
export function donutSegments(counts: number[]): { dash: number; offset: number }[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  let acc = 0;
  return counts.map((count) => {
    const dash = sum ? (count / sum) * 100 : 0;
    const seg = { dash, offset: -acc };
    acc += dash;
    return seg;
  });
}

export function formatAverage(avg: number | null | undefined): string {
  return avg === null || avg === undefined ? '\u2013' : Number(avg).toFixed(1);
}

export function responsesLabel(n: number): string {
  return n === 1 ? 'response' : 'responses';
}
