import type { AdminCloud, Cloud, CloudForm, CloudKind, CloudPayload, StormStatus } from '@/shared/types';
import { plainLine } from '@/lib/markdown';
import type { VotingPhase } from '@/composables/useVotingClock';

/** The timer lengths offered first, in seconds; anything else is typed in as custom seconds. */
export const TIMER_PRESETS = [15, 30, 60, 120, 300];
/** The longest timer the server takes (MAX_VOTING_SECONDS in lib/cloud.js). */
export const MAX_TIMER_SECONDS = 3600;

export function blankForm(): CloudForm {
  return { kind: 'choice', body: '', optionsText: '', correctText: '', display: 'bars', resultsHidden: false, multi: false, scaleMin: 1, scaleMax: 5, maxWords: 3, timerMode: 'none', timerSeconds: 60 };
}

export function parseHiddenWords(q: AdminCloud): string[] {
  return q.hidden_words ? (JSON.parse(q.hidden_words) as string[]) : [];
}

export function parseOptions(q: AdminCloud): string[] {
  return q.options ? (JSON.parse(q.options) as string[]) : [];
}

export function parseCorrect(q: AdminCloud): number[] {
  return q.correct ? (JSON.parse(q.correct) as number[]) : [];
}

export function formFromCloud(q: AdminCloud): CloudForm {
  const options = parseOptions(q);
  return {
    kind: q.kind,
    body: q.body,
    optionsText: options.join(', '),
    correctText: parseCorrect(q).map((i) => options[i]).filter(Boolean).join(', '),
    display: q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: !!q.results_hidden,
    multi: !!q.multi,
    scaleMin: q.scale_min ?? 1,
    scaleMax: q.scale_max ?? 5,
    maxWords: q.max_words ?? 3,
    timerMode: q.timer_seconds ? (q.timer_auto ? 'auto' : 'manual') : 'none',
    timerSeconds: q.timer_seconds || 60,
  };
}

function kindPayload(f: CloudForm): CloudPayload {
  if (f.kind === 'content') return { kind: 'content', body: f.body };
  // An emptied number field gives '', which the server would refuse: fall back to the default.
  if (f.kind === 'words') return { kind: 'words', body: f.body, maxWords: Number(f.maxWords) || 3, resultsHidden: !!f.resultsHidden };
  const payload: CloudPayload = { kind: f.kind, body: f.body, resultsHidden: !!f.resultsHidden };
  if (f.kind === 'choice') {
    const options = f.optionsText.split(',').map((x) => x.trim()).filter(Boolean);
    payload.options = options;
    payload.multi = !!f.multi;
    payload.display = f.display;
    const wanted = f.correctText.split(',').map((x) => x.trim()).filter(Boolean);
    const lower = options.map((o) => o.toLowerCase());
    const missing = wanted.filter((w) => !lower.includes(w.toLowerCase()));
    if (missing.length) throw new Error(`Correct answer "${missing[0]}" is not one of the options`);
    if (wanted.length) payload.correct = wanted.map((w) => lower.indexOf(w.toLowerCase()));
  } else {
    // An emptied end sends null, which takes the server's default; any other non-whole number is refused there.
    payload.scaleMin = typeof f.scaleMin === 'number' ? f.scaleMin : null;
    payload.scaleMax = typeof f.scaleMax === 'number' ? f.scaleMax : null;
  }
  return payload;
}

/** What is wrong with the form's timer, or null when it is fine (or there is none). */
export function timerError(f: CloudForm): string | null {
  if (f.timerMode === 'none') return null;
  const seconds = Number(f.timerSeconds);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_TIMER_SECONDS ? null : `The timer must be a whole number of seconds from 1 to ${MAX_TIMER_SECONDS}`;
}

/** Turns the form into an API payload; correct answers are typed as option text and mapped to indexes. A timer is only sent when set. */
export function buildCloudPayload(f: CloudForm): CloudPayload {
  const payload = kindPayload(f);
  const badTimer = timerError(f);
  if (badTimer) throw new Error(badTimer);
  if (f.timerMode !== 'none') {
    const seconds = Number(f.timerSeconds);
    payload.timerSeconds = seconds;
    payload.timerAuto = f.timerMode === 'auto';
  }
  return payload;
}

/** A length of time as people say it: 15s, 1m, 1m 30s. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (!m) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** A cloud's own timer in a few characters ("2m, auto"), or null when it has none. */
export function timerNote(q: AdminCloud): string | null {
  if (!q.timer_seconds) return null;
  return `${formatDuration(q.timer_seconds)}${q.timer_auto ? ', auto' : ''}`;
}

/** The presenter always sees the counts and correct answer, even while they are hidden from the audience. */
export function toPrivateCloud(q: AdminCloud): Cloud {
  return {
    id: q.id,
    kind: q.kind,
    body: q.body,
    options: q.options ? (JSON.parse(q.options) as string[]) : null,
    scaleMin: q.scale_min,
    scaleMax: q.scale_max,
    multi: !!q.multi,
    display: q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: false,
    correct: q.correct ? (JSON.parse(q.correct) as number[]) : null,
    maxWords: q.max_words,
  };
}

export function phaseText(kind: CloudKind) {
  if (kind === 'content') return { open: 'No timer', closed: "Time's up", lock: '', unlock: 'Clear timer' };
  if (kind === 'words') return { open: 'Submissions open', closed: 'Submissions closed', lock: 'Lock submissions', unlock: 'Unlock submissions' };
  return { open: 'Voting open', closed: 'Voting closed', lock: 'Lock voting', unlock: 'Unlock voting' };
}

export function kindLabel(c: AdminCloud): string {
  if (c.kind === 'content') return 'Content';
  if (c.kind === 'words') return `Words (up to ${c.max_words ?? 3})`;
  if (c.kind === 'choice') return c.multi ? 'Multi-select' : 'Choice';
  return `Rating ${c.scale_min}–${c.scale_max}`;
}

/** A plain, one-line version of a markdown body for compact lists. */
export function firstLine(body: string, max = 80): string {
  const line = plainLine(body);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function statusLabel(status: StormStatus): string {
  return { lobby: 'Lobby', active: 'Live', closed: 'Closed' }[status] ?? status;
}

export type StatusTone = 'on' | 'warn' | 'ok' | 'neutral';
export interface StatusLine {
  key: string;
  text: string;
  tone: StatusTone;
}

/** What the audience sees right now, as short lines for the presenter's status strip. The join state is always included. */
export function presentStatus(input: { cloud: AdminCloud | null; phase: VotingPhase; label: string; showConnect: boolean }): StatusLine[] {
  const { cloud, phase, label, showConnect } = input;
  const lines: StatusLine[] = [];
  if (!cloud) {
    lines.push({ key: 'live', text: 'No cloud is live', tone: 'neutral' });
  } else {
    const text = phaseText(cloud.kind);
    if (phase === 'running') lines.push({ key: 'state', text: `${label} left`, tone: 'on' });
    else if (phase === 'closed') lines.push({ key: 'state', text: text.closed, tone: 'warn' });
    else lines.push({ key: 'state', text: text.open, tone: cloud.kind === 'content' ? 'neutral' : 'on' });
    if (cloud.kind !== 'content' && cloud.results_hidden) lines.push({ key: 'results', text: 'Results hidden', tone: 'warn' });
  }
  lines.push(showConnect ? { key: 'join', text: 'Join screen showing', tone: 'on' } : { key: 'join', text: 'Join screen off', tone: 'neutral' });
  return lines;
}

/** A short name for a cloud's kind, for the Up next line. */
export function kindName(c: AdminCloud): string {
  return { content: 'Content', words: 'Word cloud', choice: 'Question', rating: 'Rating' }[c.kind];
}
