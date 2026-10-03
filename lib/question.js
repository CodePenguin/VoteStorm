// What the audience may see of a question. `reveal` (closed room) shows everything.
export function shapeQuestion(q, { reveal = false } = {}) {
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
    correct,
  };
}

export function publicTally(q, tally, { reveal = false } = {}) {
  if (!reveal && q.results_hidden) return { totalVotes: tally.totalVotes, hidden: true };
  return tally;
}
