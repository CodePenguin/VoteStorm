// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_RECENT, forgetStorm, loadRecent, rememberStorm, renameRemembered } from '@/lib/recentStorms';
import { agoLabel, inLabel } from '@/lib/relativeTime';

describe('recent Storms on this device', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty, remembers Storms newest first, and moves a reopened one to the top', () => {
    expect(loadRecent()).toEqual([]);
    rememberStorm({ secret: 's1', stormCode: 'AAA111' }, 1000);
    rememberStorm({ secret: 's2', stormCode: 'BBB222', name: 'Town hall' }, 2000);
    expect(loadRecent().map((e) => e.stormCode)).toEqual(['BBB222', 'AAA111']);
    rememberStorm({ secret: 's1', stormCode: 'AAA111', name: 'Renamed' }, 3000);
    expect(loadRecent().map((e) => [e.stormCode, e.name])).toEqual([['AAA111', 'Renamed'], ['BBB222', 'Town hall']]);
    expect(loadRecent()).toHaveLength(2);
  });

  it('renames without reordering, and forgets', () => {
    rememberStorm({ secret: 's1', stormCode: 'A' }, 1000);
    rememberStorm({ secret: 's2', stormCode: 'B' }, 2000);
    renameRemembered('A', 'First');
    expect(loadRecent().map((e) => [e.stormCode, e.name])).toEqual([['B', null], ['A', 'First']]);
    forgetStorm('B');
    expect(loadRecent().map((e) => e.stormCode)).toEqual(['A']);
  });

  it('keeps only the most recent ones', () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) rememberStorm({ secret: `s${i}`, stormCode: `C${i}` }, i);
    const list = loadRecent();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].stormCode).toBe(`C${MAX_RECENT + 4}`);
  });

  it('ignores stored data that is damaged, without throwing', () => {
    localStorage.setItem('votestorm_recent', 'not json');
    expect(loadRecent()).toEqual([]);
    localStorage.setItem('votestorm_recent', JSON.stringify([{ secret: 1 }, null, 'x', { adminKey: 'old', stormCode: 'O', name: null, lastOpenedAt: 9 }, { secret: 'ok', stormCode: 'S', name: null, lastOpenedAt: 5 }]));
    expect(loadRecent()).toEqual([{ secret: 'ok', stormCode: 'S', name: null, lastOpenedAt: 5 }]);
  });

  it('does not break when storage is unavailable', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('full');
    };
    try {
      expect(() => rememberStorm({ secret: 's', stormCode: 'S' })).not.toThrow();
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
