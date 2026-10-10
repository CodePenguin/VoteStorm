export const MAX_SIZE_FACTOR = 4;

/** Size relative to the smallest word: 1 for the least used, up to MAX_SIZE_FACTOR for the most used (square-root scale). */
export function wordScale(count: number, min: number, max: number): number {
  if (max <= min) return 2; // equal counts: one middling size
  return 1 + (MAX_SIZE_FACTOR - 1) * Math.sqrt((count - min) / (max - min));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A shuffle that depends only on the word, so words do not jump around as the counts change. */
export function stableOrder<T extends { word: string }>(words: T[]): T[] {
  return [...words].sort((a, b) => hash(a.word) - hash(b.word) || (a.word < b.word ? -1 : 1));
}

export const wordHash = hash;

/** What the server will store for a typed word, close enough to show it back (the server's cleaning is the real one). */
export function lightClean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
