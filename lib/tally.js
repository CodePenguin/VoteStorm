import { computeWordsTally, parseHiddenWords } from './words.js';

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

export function computeTally(cloud, votes) {
  if (cloud.kind === 'choice') {
    return computeChoiceTally(votes, JSON.parse(cloud.options), !!cloud.multi);
  }
  if (cloud.kind === 'rating') {
    return computeRatingTally(votes, cloud.scale_min, cloud.scale_max);
  }
  if (cloud.kind === 'words') return computeWordsTally(votes, parseHiddenWords(cloud));
  if (cloud.kind === 'content') return { counts: [], totalVotes: 0 };
  throw new Error(`Unknown cloud kind: ${cloud.kind}`);
}
