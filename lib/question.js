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

// What the audience may see of a question. `reveal` (closed storm) shows everything.
export function shapeQuestion(q, { reveal = false, now = Date.now() } = {}) {
  const correct = q.correct && (reveal || q.answer_shown) ? JSON.parse(q.correct) : null;
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: q.options ? JSON.parse(q.options) : null,
    scaleMin: q.scale_min,
    scaleMax: q.scale_max,
    multi: !!q.multi,
    display: q.type === 'choice' && q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: !reveal && !!q.results_hidden,
    votingMsLeft: votingMsLeft(q, now),
    correct,
  };
}

export function publicTally(q, tally, { reveal = false } = {}) {
  if (!reveal && q.results_hidden) return { totalVotes: tally.totalVotes, hidden: true };
  return tally;
}
