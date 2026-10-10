// Word clouds: each participant sends a short list of words; the tally counts how many people used each word.
export const MAX_WORD_LENGTH = 30;
export const DEFAULT_MAX_WORDS = 3;
export const MAX_MAX_WORDS = 10;
export const MAX_TALLY_WORDS = 100;
const MAX_LIST_LENGTH = 50;

// Punctuation and plain symbols are trimmed from the edges; other symbols (emoji) are real words and stay.
const EDGE_CHAR = /^[\p{P}\p{Sm}\p{Sc}\p{Sk}\s]$/u;
// Control and invisible format characters (but not the zero-width joiner U+200D that emoji sequences need, nor the
// zero-width non-joiner U+200C, handled below), and
// code points that draw as blank: Hangul fillers and the braille blank.
const INVISIBLE = /[\p{Cc}­؀-؅؜۝܏᠎​‎-‏‪-‮⁠-⁯﻿￹-￻ㅤᅟᅠﾠ⠀]|[\u{110BD}\u{110CD}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/gu;
// The zero-width non-joiner is part of the spelling between letters (the Persian half-space, as in the word for
// 'I want'); anywhere else it is invisible noise. A run of them counts as one.
const ZWNJ_RUN = /\u200C+/gu;
const STRAY_ZWNJ = /(?<![\p{L}\p{M}])\u200C|\u200C(?![\p{L}\p{M}])/gu;
// An entry that has none of these draws as nothing (lone combining marks, variation selectors) and is dropped.
const HAS_CONTENT = /[\p{L}\p{N}\p{So}]/u;
// A raw entry longer than this can never become a valid word, so it is refused before any cleaning work.
const MAX_RAW_LENGTH = 200;

/** One word or short phrase as it is stored and counted: lower case, single spaces, no punctuation at the edges. Linear in the input. */
export function cleanWord(text) {
  if (typeof text !== 'string') return '';
  // Whitespace becomes single spaces before invisible characters go (tabs are control characters too) and again after,
  // so a space on each side of a removed invisible character does not leave two.
  const visible = text.normalize('NFC').replace(/\s+/gu, ' ').replace(INVISIBLE, '').replace(ZWNJ_RUN, '\u200C').replace(STRAY_ZWNJ, '');
  const chars = [...visible.replace(/\s+/gu, ' ').toLowerCase()];
  let start = 0;
  let end = chars.length;
  while (start < end && EDGE_CHAR.test(chars[start])) start++;
  while (end > start && EDGE_CHAR.test(chars[end - 1])) end--;
  const word = chars.slice(start, end).join('');
  return HAS_CONTENT.test(word) ? word : '';
}

/** Returns { words } (cleaned, no repeats) or { error } fit for a 400. */
export function cleanWordList(value, maxWords) {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) return { error: 'Send a list of words' };
  const words = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { error: 'Each word must be text' };
    if (entry.length > MAX_RAW_LENGTH) return { error: `A word can be at most ${MAX_WORD_LENGTH} characters` };
    const word = cleanWord(entry);
    if (!word) continue;
    if ([...word].length > MAX_WORD_LENGTH) return { error: `A word can be at most ${MAX_WORD_LENGTH} characters` };
    if (!words.includes(word)) words.push(word);
  }
  if (words.length === 0) return { error: 'Enter at least one word' };
  if (words.length > maxWords) return { error: `You can send at most ${maxWords} word${maxWords === 1 ? '' : 's'}` };
  return { words };
}

export function parseHiddenWords(cloud) {
  try {
    const parsed = JSON.parse(cloud?.hidden_words ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

// A response is a JSON array of cleaned words in one row, so totalVotes counts people and each word's count is how many
// of them used it. Words the presenter removed are left out of the list but their senders still count.
export function computeWordsTally(votes, hiddenWords = []) {
  const hidden = new Set(hiddenWords);
  const counts = new Map();
  let totalVotes = 0;
  for (const vote of votes) {
    let list;
    try {
      list = JSON.parse(vote.value);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    totalVotes++;
    for (const word of new Set(list)) {
      if (typeof word === 'string' && !hidden.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const words = [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, MAX_TALLY_WORDS);
  return { words, totalVotes };
}
