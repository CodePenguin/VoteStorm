// Multi-select votes are stored as a JSON array of option indexes in one row, so
// totalVotes counts people and each option's count is how many of them picked it.
export function parseChoiceValues(value, multi) {
  if (!multi) return [Number(value)];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

export function computeChoiceTally(votes, options, multi = false) {
  const counts = options.map(() => 0);
  for (const vote of votes) {
    for (const idx of new Set(parseChoiceValues(vote.value, multi))) {
      if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx]++;
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
    return computeChoiceTally(votes, JSON.parse(question.options), !!question.multi);
  }
  if (question.type === 'rating') {
    return computeRatingTally(votes, question.scale_min, question.scale_max);
  }
  throw new Error(`Unknown question type: ${question.type}`);
}
