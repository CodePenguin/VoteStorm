import { DEFAULT_MAX_WORDS } from './words.js';

export const MAX_VOTING_SECONDS = 3600;

// closes_at is when voting stops: NULL while open, a future time while a timer runs, a past time once locked.
export function votingClosed(q, now = Date.now()) {
  return q.closes_at !== null && q.closes_at !== undefined && now >= Number(q.closes_at);
}

/** null while open, 0 once closed, otherwise the milliseconds left. Sent as a duration so no client clock has to agree with ours. */
export function votingMsLeft(q, now = Date.now()) {
  if (q.closes_at === null || q.closes_at === undefined) return null;
  return Math.max(0, Number(q.closes_at) - now);
}

/** When voting should close for a cloud that has just come live: its own timer if that starts by itself, else null (open). */
export function closesAtOnActivation(cloud, now = Date.now()) {
  const seconds = Number(cloud.timer_seconds);
  return Number(cloud.timer_auto) === 1 && Number.isInteger(seconds) && seconds > 0 ? now + seconds * 1000 : null;
}

// What the audience may see of a cloud. `reveal` (closed storm) shows everything.
export function shapeCloud(q, { reveal = false, now = Date.now() } = {}) {
  const correct = q.correct && (reveal || q.answer_shown) ? JSON.parse(q.correct) : null;
  return {
    id: q.id,
    kind: q.kind,
    body: q.body,
    options: q.options ? JSON.parse(q.options) : null,
    scaleMin: q.scale_min,
    scaleMax: q.scale_max,
    multi: !!q.multi,
    display: q.kind === 'choice' && q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: !reveal && !!q.results_hidden,
    votingMsLeft: votingMsLeft(q, now),
    correct,
    maxWords: q.kind === 'words' ? Number(q.max_words) || DEFAULT_MAX_WORDS : null,
  };
}

export function publicTally(q, tally, { reveal = false } = {}) {
  if (!reveal && q.results_hidden) return { totalVotes: tally.totalVotes, hidden: true };
  return tally;
}
