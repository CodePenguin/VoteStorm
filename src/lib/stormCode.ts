/** Uppercase with spaces and hyphens removed, so `abcd-efgh` and `ABCD EFGH` are the same code. */
export const normalizeStormCode = (text: string) => text.toUpperCase().replace(/[\s-]/g, '');

/** `ABCDEFGH` as `ABCD EFGH` for people to read. Links always use the contiguous form. */
export const formatStormCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);
