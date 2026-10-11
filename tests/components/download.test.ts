// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadText, fileSlug, readFileText } from '@/lib/download';

describe('file helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names a file after the Storm, or after its code when the name gives nothing', () => {
    expect(fileSlug('Town Hall: Q3 / 2026', 'ABCDEFGH')).toBe('town-hall-q3-2026');
    expect(fileSlug('Café Ünïcode', 'ABCDEFGH')).toBe('cafe-unicode');
    expect(fileSlug('🌩️🌩️', 'ABCDEFGH')).toBe('storm-abcdefgh');
    expect(fileSlug(null, 'ABCDEFGH')).toBe('storm-abcdefgh');
    expect(fileSlug('x'.repeat(200), 'ABCDEFGH')).toHaveLength(60);
  });

  it('saves text through a temporary link and lets the object URL go afterwards', () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:test'));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('a.csv');
      expect(this.getAttribute('href')).toBe('blob:test');
    });
    downloadText('a.csv', 'x', 'text/csv;charset=utf-8');
    expect(click).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe('text/csv;charset=utf-8');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('reads a chosen file as text', async () => {
    expect(await readFileText(new File(['{"a":1}'], 'f.json'))).toBe('{"a":1}');
  });
});
