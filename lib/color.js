/** A stored colour is always lowercase `#rrggbb`. Anything else is rejected, so no free-form CSS ever reaches a page. */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toLowerCase()}` : undefined;
}
