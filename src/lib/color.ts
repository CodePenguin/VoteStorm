const HEX = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` (lowercase) from what a person typed, or null if it is not a six-digit hex colour. */
export function parseHexColor(value: string): string | null {
  const match = value.trim().match(HEX);
  return match ? `#${match[1].toLowerCase()}` : null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** Above this, dark text has more contrast than white text. */
const LIGHT_BACKGROUND = 0.179;

const LIGHT = {
  '--text': '#0f172a', '--text-muted': '#475569', '--accent': '#2563eb', '--accent-contrast': '#ffffff', '--accent-soft': '#dbe7ff',
  '--success': '#15803d', '--success-soft': '#e7f6ec', '--warn': '#b45309', '--danger': '#b91c1c',
  '--surface': 'color-mix(in srgb, #ffffff 55%, var(--bg))', '--surface-2': 'color-mix(in srgb, #000000 6%, var(--bg))', '--border': 'color-mix(in srgb, #000000 16%, var(--bg))',
};
const DARK = {
  '--text': '#f8fafc', '--text-muted': '#cbd5e1', '--accent': '#5b8cff', '--accent-contrast': '#0b1120', '--accent-soft': '#1b2c52',
  '--success': '#4ade80', '--success-soft': '#10301d', '--warn': '#fbbf24', '--danger': '#f87171',
  '--surface': 'color-mix(in srgb, #ffffff 8%, var(--bg))', '--surface-2': 'color-mix(in srgb, #ffffff 14%, var(--bg))', '--border': 'color-mix(in srgb, #ffffff 22%, var(--bg))',
};

/** The theme variables for a results screen with this background: text, bars and borders flip light or dark so it stays readable. */
export function resultsTheme(hex: string | null | undefined): Record<string, string> {
  const color = hex ? parseHexColor(hex) : null;
  if (!color) return {};
  return { '--bg': color, ...(luminance(color) > LIGHT_BACKGROUND ? LIGHT : DARK) };
}
