import { describe, it, expect } from 'vitest';
import { fragmentFor, presenterLocation, readFragment, resultsUrl } from '@/lib/fragment';

describe('fragment links', () => {
  it('reads and writes key=value pairs after the #, leaving out what is not set', () => {
    expect(readFragment('#k=a&t=b').get('k')).toBe('a');
    expect(readFragment('k=abc').get('k')).toBe('abc');
    expect(readFragment('').get('k')).toBeNull();
    expect(fragmentFor({ k: 'abc', t: 'storm' })).toBe('#k=abc&t=storm');
    expect(fragmentFor({ k: 'abc', t: null, q: undefined })).toBe('#k=abc');
    expect(fragmentFor({})).toBe('');
    expect(fragmentFor({ k: 'abc', q: 7 })).toBe('#k=abc&q=7');
  });

  it('builds presenter and results links with the secret only after the #', () => {
    expect(presenterLocation('ABCDEFGH', 'S', 'storm')).toEqual({ path: '/presenter/ABCDEFGH', hash: '#k=S&t=storm' });
    expect(presenterLocation('ABCDEFGH', 'S')).toEqual({ path: '/presenter/ABCDEFGH', hash: '#k=S' });
    expect(presenterLocation('ABCDEFGH')).toEqual({ path: '/presenter/ABCDEFGH', hash: '' });
    expect(resultsUrl('https://x', 'RK', 7)).toBe('https://x/results#k=RK&q=7');
    expect(resultsUrl('https://x.test', 'RK')).toBe('https://x.test/results#k=RK');
  });

  it('survives awkward characters', () => {
    expect(readFragment(fragmentFor({ k: 'a&b=c d' })).get('k')).toBe('a&b=c d');
  });
});
