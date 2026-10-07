import { describe, it, expect } from 'vitest';
import { contrastRatio, luminance, parseHexColor, resultsTheme } from '@/lib/color';

describe('colour helpers', () => {
  it('accepts six-digit hex with or without the #, in any case, and rejects everything else', () => {
    expect(parseHexColor('1E293B')).toBe('#1e293b');
    expect(parseHexColor(' #FFcc00 ')).toBe('#ffcc00');
    for (const bad of ['', 'red', '#fff', '#12345', '#gggggg', 'rgb(0,0,0)']) expect(parseHexColor(bad)).toBeNull();
  });

  it('measures luminance and contrast from black to white', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(luminance('#ffff00')).toBeGreaterThan(luminance('#0000ff'));
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
    expect(contrastRatio('#336699', '#336699')).toBe(1);
  });

  it('uses dark text on light backgrounds and light text on dark ones', () => {
    expect(resultsTheme('#ffffff')).toMatchObject({ '--bg': '#ffffff', '--text': '#0f172a' });
    expect(resultsTheme('#ffcc00')['--text']).toBe('#0f172a');
    expect(resultsTheme('#1e293b')).toMatchObject({ '--bg': '#1e293b', '--text': '#f8fafc' });
    expect(resultsTheme('#000000')['--text']).toBe('#f8fafc');
  });

  it('keeps text, muted text and the accent readable on any background, including mid-tones', () => {
    const backgrounds = [
      '#ffffff', '#000000', '#1e293b', '#fff3b0', '#3b82f6', '#2563eb', '#ef4444', '#22c55e', '#f59e0b', '#808080', '#777777', '#a855f7', '#0ea5e9', '#14b8a6', '#fb923c', '#64748b',
    ];
    for (const bg of backgrounds) {
      const theme = resultsTheme(bg);
      expect(contrastRatio(theme['--text'], bg), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['--text-muted'], bg), `muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['--accent'], bg), `accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['--accent-contrast'], theme['--accent']), `text on accent for ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives every theme variable a plain hex value, so it works in any browser', () => {
    for (const value of Object.values(resultsTheme('#3b82f6'))) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('changes nothing without a valid colour', () => {
    expect(resultsTheme(null)).toEqual({});
    expect(resultsTheme(undefined)).toEqual({});
    expect(resultsTheme('red')).toEqual({});
  });
});
