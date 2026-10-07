// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { fragmentFor, presenterLocation, readFragment, resultsUrl } from '@/lib/fragment';
import { MAX_RECENT, forgetStorm, loadRecent, rememberStorm, renameRemembered } from '@/lib/recentStorms';
import { agoLabel, inLabel } from '@/lib/relativeTime';

describe('fragment links', () => {
  it('reads and writes key=value pairs after the #, leaving out what is not set', () => {
    expect(readFragment('#key=abc&tab=storm').get('key')).toBe('abc');
    expect(readFragment('key=abc').get('key')).toBe('abc');
    expect(readFragment('').get('key')).toBeNull();
    expect(fragmentFor({ key: 'abc', tab: 'storm' })).toBe('#key=abc&tab=storm');
    expect(fragmentFor({ key: 'abc', tab: null, q: undefined })).toBe('#key=abc');
    expect(fragmentFor({})).toBe('');
    expect(fragmentFor({ key: 'abc', q: 7 })).toBe('#key=abc&q=7');
  });

  it('builds presenter and results links with the secret only after the #', () => {
    expect(presenterLocation('K1')).toEqual({ path: '/presenter', hash: '#key=K1' });
    expect(presenterLocation('K1', 'storm')).toEqual({ path: '/presenter', hash: '#key=K1&tab=storm' });
    expect(presenterLocation()).toEqual({ path: '/presenter', hash: '' });
    expect(resultsUrl('https://x.test', 'RK')).toBe('https://x.test/results#key=RK');
    expect(resultsUrl('https://x.test', 'RK', 5)).toBe('https://x.test/results#key=RK&q=5');
  });

  it('survives awkward characters', () => {
    expect(readFragment(fragmentFor({ key: 'a&b=c d' })).get('key')).toBe('a&b=c d');
  });
});

describe('recent Storms on this device', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty, remembers Storms newest first, and moves a reopened one to the top', () => {
    expect(loadRecent()).toEqual([]);
    rememberStorm({ adminKey: 'k1', stormCode: 'AAA111' }, 1000);
    rememberStorm({ adminKey: 'k2', stormCode: 'BBB222', name: 'Town hall' }, 2000);
    expect(loadRecent().map((e) => e.adminKey)).toEqual(['k2', 'k1']);
    rememberStorm({ adminKey: 'k1', stormCode: 'AAA111', name: 'Renamed' }, 3000);
    expect(loadRecent().map((e) => [e.adminKey, e.name])).toEqual([['k1', 'Renamed'], ['k2', 'Town hall']]);
  });

  it('renames without reordering, and forgets', () => {
    rememberStorm({ adminKey: 'k1', stormCode: 'A' }, 1000);
    rememberStorm({ adminKey: 'k2', stormCode: 'B' }, 2000);
    renameRemembered('k1', 'First');
    expect(loadRecent().map((e) => [e.adminKey, e.name])).toEqual([['k2', null], ['k1', 'First']]);
    forgetStorm('k2');
    expect(loadRecent().map((e) => e.adminKey)).toEqual(['k1']);
  });

  it('keeps only the most recent ones', () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) rememberStorm({ adminKey: `k${i}`, stormCode: `C${i}` }, i);
    const list = loadRecent();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].adminKey).toBe(`k${MAX_RECENT + 4}`);
  });

  it('ignores stored data that is damaged, without throwing', () => {
    localStorage.setItem('votestorm_recent', 'not json');
    expect(loadRecent()).toEqual([]);
    localStorage.setItem('votestorm_recent', JSON.stringify([{ adminKey: 1 }, null, 'x', { adminKey: 'ok', stormCode: 'S', name: null, lastOpenedAt: 5 }]));
    expect(loadRecent()).toEqual([{ adminKey: 'ok', stormCode: 'S', name: null, lastOpenedAt: 5 }]);
  });

  it('does not break when storage is unavailable', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('full');
    };
    try {
      expect(() => rememberStorm({ adminKey: 'k', stormCode: 'S' })).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('relative time labels', () => {
  it('says how long ago and how long until', () => {
    const now = 1_000_000_000;
    expect(agoLabel(now - 5000, now)).toBe('just now');
    expect(agoLabel(now - 5 * 60000, now)).toBe('5 min ago');
    expect(agoLabel(now - 3 * 3600000, now)).toBe('3 h ago');
    expect(agoLabel(now - 2 * 86400000, now)).toBe('2 d ago');
    expect(inLabel(now + 10 * 3600000, now)).toBe('in 10 h');
    expect(inLabel(now + 30000, now)).toBe('in less than a minute');
    expect(inLabel(now - 1, now)).toBe('expired');
  });
});
