import { describe, it, expect } from 'vitest';
import { luminance, parseHexColor, resultsTheme } from '@/lib/color';

describe('colour helpers', () => {
  it('accepts six-digit hex with or without the #, in any case, and rejects everything else', () => {
    expect(parseHexColor('1E293B')).toBe('#1e293b');
    expect(parseHexColor(' #FFcc00 ')).toBe('#ffcc00');
    for (const bad of ['', 'red', '#fff', '#12345', '#gggggg', 'rgb(0,0,0)']) expect(parseHexColor(bad)).toBeNull();
  });

  it('measures luminance from black to white', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(luminance('#ffff00')).toBeGreaterThan(luminance('#0000ff'));
  });

  it('uses dark text on light backgrounds and light text on dark ones', () => {
    expect(resultsTheme('#ffffff')).toMatchObject({ '--bg': '#ffffff', '--text': '#0f172a' });
    expect(resultsTheme('#ffcc00')['--text']).toBe('#0f172a');
    expect(resultsTheme('#1e293b')).toMatchObject({ '--bg': '#1e293b', '--text': '#f8fafc' });
    expect(resultsTheme('#000000')['--text']).toBe('#f8fafc');
  });

  it('changes nothing without a valid colour', () => {
    expect(resultsTheme(null)).toEqual({});
    expect(resultsTheme(undefined)).toEqual({});
    expect(resultsTheme('red')).toEqual({});
  });
});
