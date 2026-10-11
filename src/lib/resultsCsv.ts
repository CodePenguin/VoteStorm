import type { Cloud, Tally } from '@/shared/types';
import { hasCounts, isWordsTally, ratingValues } from '@/lib/tally';

export interface CsvCloud {
  kind: Cloud['kind'];
  body: string;
  options: string[] | null;
  scaleMin: number | null;
  scaleMax: number | null;
  tally: Tally | null | undefined;
  /** Words the presenter removed: left out even if a tally still lists them. */
  hiddenWords?: string[];
}

const HEADER = ['storm', 'cloud', 'kind', 'prompt', 'answer', 'count', 'percent'];
// A spreadsheet reads a cell starting with one of these as a formula; a leading apostrophe keeps it plain text.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field. Text is guarded against formulas and quoted when RFC 4180 needs it; numbers are written as they are. */
export function csvField(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The prompt: the first line of a cloud's body, without heading markers (a body usually starts with a heading). */
export function promptLine(body: string): string {
  const first = body.trim().split(/\r?\n/)[0] ?? '';
  return first.replace(/^#{1,6}(?=\s|$)/, '').trim();
}

const percent = (count: number, total: number) => (total ? (count / total) * 100 : 0).toFixed(1);

/**
 * A Storm's results as CSV: one row per option, rating value or word, content clouds left out. `cloud` is the position
 * in the Storm. UTF-8 byte-order mark and CRLF line ends, so Excel shows accents and emoji and splits the lines.
 */
export function resultsCsv(storm: string, clouds: CsvCloud[]): string {
  const rows: (string | number)[][] = [HEADER];
  clouds.forEach((cloud, index) => {
    if (cloud.kind === 'content') return;
    const tally = cloud.tally;
    const total = tally?.totalVotes || 0;
    const base = [storm, index + 1, cloud.kind, promptLine(cloud.body)];
    if (cloud.kind === 'words') {
      const hidden = new Set(cloud.hiddenWords ?? []);
      for (const { word, count } of isWordsTally(tally) ? tally.words : []) {
        if (!hidden.has(word)) rows.push([...base, word, count, percent(count, total)]);
      }
      return;
    }
    const counts = (hasCounts(tally) ? tally.counts : {}) as Record<number, number>;
    const answers: [string | number, number][] = cloud.kind === 'choice'
      ? (cloud.options ?? []).map((option, i) => [option, counts[i] ?? 0])
      : ratingValues(cloud).map((value) => [value, counts[value] ?? 0]);
    for (const [answer, count] of answers) rows.push([...base, answer, count, percent(count, total)]);
  });
  return `\uFEFF${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}
