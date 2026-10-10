import type { AdminCloud, Cloud, CloudForm, CloudKind, CloudPayload, StormStatus } from '@/shared/types';
import { plainLine } from '@/lib/markdown';
import type { VotingPhase } from '@/composables/useVotingClock';

export function blankForm(): CloudForm {
  return { kind: 'choice', body: '', optionsText: '', correctText: '', display: 'bars', resultsHidden: false, multi: false, scaleMin: 1, scaleMax: 5, maxWords: 3 };
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
  };
}

/** Turns the form into an API payload; correct answers are typed as option text and mapped to indexes. */
export function buildCloudPayload(f: CloudForm): CloudPayload {
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
    payload.scaleMin = f.scaleMin;
    payload.scaleMax = f.scaleMax;
  }
  return payload;
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
