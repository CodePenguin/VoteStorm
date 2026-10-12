// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_RECENT, forgetStorm, loadRecent, mergeLists, mergeRecent, rememberStorm, renameRemembered } from '@/lib/recentStorms';
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

  describe('mergeRecent', () => {
    const entry = (code: string, secret: string, at: number, name: string | null = null) => ({ stormCode: code, secret, name, lastOpenedAt: at });

    it('adds Storms this browser lacks and counts them', () => {
      rememberStorm({ secret: 's1', stormCode: 'AAA' }, 1000);
      const result = mergeRecent([entry('BBB', 's2', 2000), entry('CCC', 's3', 3000)], 10_000);
      expect(result).toEqual({ added: 2, updated: 0, kept: 0 });
      expect(loadRecent().map((e) => e.stormCode)).toEqual(['CCC', 'BBB', 'AAA']);
    });

    it('lets a newer incoming secret replace the local one, and counts it as updated', () => {
      rememberStorm({ secret: 'old', stormCode: 'AAA', name: 'Town hall' }, 1000);
      const result = mergeRecent([entry('AAA', 'new', 5000, 'Town hall 2')], 10_000);
      expect(result).toEqual({ added: 0, updated: 1, kept: 0 });
      expect(loadRecent()[0]).toMatchObject({ stormCode: 'AAA', secret: 'new', name: 'Town hall 2', lastOpenedAt: 5000 });
    });

    it('never overwrites a newer or equal local entry, and leaves a same-secret entry as already here', () => {
      rememberStorm({ secret: 'local', stormCode: 'AAA' }, 5000);
      rememberStorm({ secret: 'same', stormCode: 'BBB' }, 1000);
      const result = mergeRecent([entry('AAA', 'older', 4000), entry('BBB', 'same', 9000)], 10_000);
      expect(result).toEqual({ added: 0, updated: 0, kept: 2 });
      expect(loadRecent().find((e) => e.stormCode === 'AAA')?.secret).toBe('local');
    });

    it('treats a timestamp from the future as now, so a hostile or wrong clock cannot always win', () => {
      rememberStorm({ secret: 'local', stormCode: 'AAA' }, 8000);
      mergeRecent([entry('AAA', 'future', 9e15)], 9000);
      expect(loadRecent()[0]).toMatchObject({ secret: 'future', lastOpenedAt: 9000 });
      mergeRecent([entry('AAA', 'later', 9e15)], 9000); // not newer than 9000
      expect(loadRecent()[0].secret).toBe('future');
    });

    it('keeps the 50 newest and only counts Storms that survive the cap', () => {
      for (let i = 0; i < MAX_RECENT; i++) rememberStorm({ secret: `s${i}`, stormCode: `L${i}` }, 1000 + i);
      const result = mergeRecent([entry('NEWER', 'n', 9000), entry('OLDER', 'o', 1)], 10_000);
      expect(result).toEqual({ added: 1, updated: 0, kept: 1 });
      const list = loadRecent();
      expect(list).toHaveLength(MAX_RECENT);
      expect(list[0].stormCode).toBe('NEWER');
      expect(list.some((e) => e.stormCode === 'OLDER')).toBe(false);
    });

    it('mergeLists leaves its inputs and storage alone', () => {
      const local = [entry('AAA', 's1', 1000)];
      const { merged, result } = mergeLists(local, [entry('BBB', 's2', 2000)], 5000);
      expect(result).toEqual({ added: 1, updated: 0, kept: 0 });
      expect(merged.map((e) => e.stormCode)).toEqual(['BBB', 'AAA']);
      expect(local).toHaveLength(1);
      expect(loadRecent()).toEqual([]);
    });

    it('does nothing for an empty list and ignores unreadable stored entries', () => {
      localStorage.setItem('votestorm_recent', JSON.stringify([{ nonsense: true }, entry('AAA', 's', 1000)]));
      expect(mergeRecent([], 5000)).toEqual({ added: 0, updated: 0, kept: 0 });
      expect(loadRecent().map((e) => e.stormCode)).toEqual(['AAA']);
    });
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
