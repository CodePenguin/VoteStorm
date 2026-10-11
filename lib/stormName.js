export const MAX_NAME_LENGTH = 80;

/** A storm name as stored: trimmed, at most MAX_NAME_LENGTH characters, empty meaning none (null). Undefined if it is not a usable name. */
export function normalizeStormName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) return undefined;
  return name === '' ? null : name;
}
