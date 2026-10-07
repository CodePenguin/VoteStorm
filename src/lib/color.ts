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

/** WCAG contrast ratio between two colours, 1 (none) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `share` of `a` blended into `b`, as `#rrggbb`. */
function mix(a: string, b: string, share: number): string {
  const channel = (i: number) => {
    const x = parseInt(a.slice(1 + i * 2, 3 + i * 2), 16);
    const y = parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(x * share + y * (1 - share)).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

const INK = '#0f172a';
const PAPER = '#f8fafc';
const READABLE = 4.5;

// Status colours come in pairs (text on its own soft background), so they stay readable whatever the page background is.
const ON_LIGHT = {
  '--success': '#14703a', '--success-soft': '#e7f6ec', '--warn': '#a24b06', '--warn-soft': '#fef3e2', '--danger': '#b91c1c', '--danger-soft': '#fdeaea',
};
const ON_DARK = {
  '--success': '#4ade80', '--success-soft': '#10301d', '--warn': '#fbbf24', '--warn-soft': '#33260c', '--danger': '#f87171', '--danger-soft': '#3a1717',
};

/**
 * The theme variables for a results screen with this background. Text is whichever of dark or light reads better, and
 * the muted text, accent, surfaces and borders are worked out from the real background so every colour stays readable,
 * including mid-tones where neither black nor white is comfortable.
 */
export function resultsTheme(hex: string | null | undefined): Record<string, string> {
  const bg = hex ? parseHexColor(hex) : null;
  if (!bg) return {};

  // The softer ink and paper first; pure black or white only where those fall short (the grey middle of the range).
  let darkText = contrastRatio(INK, bg) >= contrastRatio(PAPER, bg);
  let text = darkText ? INK : PAPER;
  if (contrastRatio(text, bg) < READABLE) {
    darkText = contrastRatio('#000000', bg) >= contrastRatio('#ffffff', bg);
    text = darkText ? '#000000' : '#ffffff';
  }

  let muted = mix(text, bg, 0.78);
  if (contrastRatio(muted, bg) < READABLE) muted = text;

  const accent = (darkText ? ['#2563eb', '#1d4ed8'] : ['#5b8cff', '#7aa2ff']).find((c) => contrastRatio(c, bg) >= READABLE) ?? text;
  const accentContrast = contrastRatio(INK, accent) >= contrastRatio('#ffffff', accent) ? INK : '#ffffff';

  return {
    '--bg': bg,
    '--text': text,
    '--text-muted': muted,
    '--accent': accent,
    '--accent-contrast': accentContrast,
    '--accent-soft': mix(accent, bg, 0.16),
    '--surface': darkText ? mix('#ffffff', bg, 0.55) : mix('#ffffff', bg, 0.08),
    '--surface-2': darkText ? mix('#000000', bg, 0.06) : mix('#ffffff', bg, 0.14),
    '--border': darkText ? mix('#000000', bg, 0.16) : mix('#ffffff', bg, 0.22),
    ...(darkText ? ON_LIGHT : ON_DARK),
  };
}
