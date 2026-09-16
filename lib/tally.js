export function computeChoiceTally(votes, options) {
  const counts = options.map(() => 0);
  for (const vote of votes) {
    const idx = Number(vote.value);
    if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) {
      counts[idx]++;
    }
  }
  return { counts, totalVotes: votes.length };
}

export function computeRatingTally(votes, scaleMin, scaleMax) {
  const counts = {};
  for (let v = scaleMin; v <= scaleMax; v++) counts[v] = 0;
  let sum = 0;
  let total = 0;
  for (const vote of votes) {
    const value = Number(vote.value);
    if (Number.isInteger(value) && value >= scaleMin && value <= scaleMax) {
      counts[value]++;
      sum += value;
      total++;
    }
  }
  return {
    counts,
    totalVotes: total,
    average: total > 0 ? sum / total : null,
  };
}

export function computeTally(question, votes) {
  if (question.type === 'choice') {
    return computeChoiceTally(votes, JSON.parse(question.options));
  }
  if (question.type === 'rating') {
    return computeRatingTally(votes, question.scale_min, question.scale_max);
  }
  throw new Error(`Unknown question type: ${question.type}`);
}
