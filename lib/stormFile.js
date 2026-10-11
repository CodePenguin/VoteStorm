import { normalizeCloudInput } from './cloudInput.js';
import { normalizeHexColor } from './color.js';
import { MAX_NAME_LENGTH, normalizeStormName } from './stormName.js';

// A Storm's shape as a file: its name, results background and clouds, and nothing that belongs to a session (no votes,
// removed words, codes or keys). The browser builds it for export and reads it before an import; the server reads it
// again and trusts nothing in it. No Node built-ins here or in what it imports: the browser bundles this module too.
export const STORM_FILE_VERSION = 1;
export const MAX_IMPORT_CLOUDS = 100;
export const MAX_IMPORT_BYTES = 1_000_000;

const parseJsonColumn = (text) => (text ? JSON.parse(text) : null);

/** The file for a Storm, from the rows the presenter API returns. Keys in a fixed order, so one Storm always gives one file. */
export function buildStormFile({ name, resultsBackground, clouds }) {
  return {
    votestorm: STORM_FILE_VERSION,
    name: name || null,
    resultsBackground: resultsBackground || null,
    clouds: clouds.map((q) => {
      const timerSeconds = q.timer_seconds ? Number(q.timer_seconds) : null;
      return {
        kind: q.kind,
        body: q.body,
        options: parseJsonColumn(q.options),
        scaleMin: q.scale_min ?? null,
        scaleMax: q.scale_max ?? null,
        multi: !!Number(q.multi),
        display: q.kind === 'choice' && q.display === 'donut' ? 'donut' : 'bars',
        resultsHidden: !!Number(q.results_hidden),
        correct: parseJsonColumn(q.correct),
        maxWords: q.max_words ?? null,
        timerSeconds,
        timerAuto: timerSeconds !== null && !!Number(q.timer_auto),
      };
    }),
  };
}

/** The file as Export saves it. */
export const stormFileText = (file) => `${JSON.stringify(file, null, 2)}\n`;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks a parsed file. Returns { error } naming what is wrong, or { value } with everything cleaned and ready to store. */
export function parseStormFile(data) {
  if (!isPlainObject(data)) return { error: 'This is not a VoteStorm file' };
  if (data.votestorm !== STORM_FILE_VERSION) return { error: 'This is not a VoteStorm file this version can read' };

  const name = normalizeStormName(data.name);
  if (name === undefined) return { error: `The name must be text of at most ${MAX_NAME_LENGTH} characters` };

  let resultsBackground = null;
  if (data.resultsBackground !== undefined && data.resultsBackground !== null && data.resultsBackground !== '') {
    resultsBackground = normalizeHexColor(data.resultsBackground);
    if (resultsBackground === undefined) return { error: 'The results background must be a colour like #1e293b' };
  }

  if (!Array.isArray(data.clouds)) return { error: 'The file has no list of clouds' };
  if (data.clouds.length > MAX_IMPORT_CLOUDS) {
    return { error: `The file has ${data.clouds.length} clouds; at most ${MAX_IMPORT_CLOUDS} can be imported` };
  }

  const clouds = [];
  for (const [i, c] of data.clouds.entries()) {
    const where = `Cloud ${i + 1}`;
    if (!isPlainObject(c)) return { error: `${where}: this is not a cloud` };
    // normalizeCloudInput turns any option into text; from a file only text is an option.
    if (c.options !== undefined && c.options !== null && (!Array.isArray(c.options) || c.options.some((o) => typeof o !== 'string'))) {
      return { error: `${where}: the options must be a list of text` };
    }
    const parsed = normalizeCloudInput(c);
    if (parsed.error) return { error: `${where}: ${parsed.error}` };
    clouds.push(parsed.value);
  }
  return { value: { name, resultsBackground, clouds } };
}

/** Reads a file's text: { error }, or { data, value } where data is the parsed JSON (sent to the server as it is). */
export function readStormFileText(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { error: 'This file is not valid JSON' };
  }
  const parsed = parseStormFile(data);
  return parsed.error ? { error: parsed.error } : { data, value: parsed.value };
}
