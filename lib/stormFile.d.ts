// Types for lib/stormFile.js, which the browser imports through src/lib/stormFile.ts.
export const STORM_FILE_VERSION: 1;
export const MAX_IMPORT_CLOUDS: number;
export const MAX_IMPORT_BYTES: number;

export interface StormFileCloud {
  kind: 'choice' | 'rating' | 'words' | 'content';
  body: string;
  options: string[] | null;
  scaleMin: number | null;
  scaleMax: number | null;
  multi: boolean;
  display: 'bars' | 'donut';
  resultsHidden: boolean;
  correct: number[] | null;
  maxWords: number | null;
  timerSeconds: number | null;
  timerAuto: boolean;
}

export interface StormFile {
  votestorm: 1;
  name: string | null;
  resultsBackground: string | null;
  clouds: StormFileCloud[];
}

/** A cloud row as the presenter API returns it: only the fields the file needs. */
export interface StormFileRow {
  kind: string;
  body: string;
  options: string | null;
  scale_min: number | null;
  scale_max: number | null;
  multi: number | boolean;
  display: string | null;
  results_hidden: number | boolean;
  correct: string | null;
  max_words: number | null;
  timer_seconds?: number | null;
  timer_auto?: number | boolean;
}

/** A checked file: the Storm's name and background, and each cloud as normalizeCloudInput returns it. */
export interface CheckedStorm {
  name: string | null;
  resultsBackground: string | null;
  clouds: Record<string, unknown>[];
}

export function buildStormFile(input: { name?: string | null; resultsBackground?: string | null; clouds: StormFileRow[] }): StormFile;
export function stormFileText(file: StormFile): string;
export function parseStormFile(data: unknown): { error: string; value?: undefined } | { error?: undefined; value: CheckedStorm };
export function readStormFileText(text: string): { error: string; data?: undefined; value?: undefined } | { error?: undefined; data: unknown; value: CheckedStorm };
