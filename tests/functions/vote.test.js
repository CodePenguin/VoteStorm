import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

// Wrap (not replace) createDb so most tests get the real libSQL client
// unchanged, but a single test can swap in a mocked client for one call to
// simulate a non-constraint DB failure on the vote insert.
vi.mock('../../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createDb: vi.fn(actual.createDb) };
});

import { publishEvent } from '../../lib/realtime.js';
import { createDb, initSchema } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler } from '../../netlify/functions/vote.js';

describe('vote function', () => {
  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    await seedStorm(db, { storm_code: 'STORM01', status: 'active', current_cloud_id: 1 });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (1, 'STORM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('finds the storm from a lower-case, hyphenated code and publishes on the stored code', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'storm-01', cloudId: 1, deviceId: 'dev-norm', value: 0 }),
    });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith('STORM01', 'tally', expect.objectContaining({ cloudId: 1 }));
  });

  describe('locked and timed voting', () => {
    const cast = (value, deviceId = 'dev-a') => handler({ httpMethod: 'POST', body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId, value }) });
    const setClosesAt = (ms) => createDb().execute({ sql: 'UPDATE clouds SET closes_at = ? WHERE id = 1', args: [ms] });

    it('accepts votes while a timer is still running', async () => {
      await setClosesAt(Date.now() + 60000);
      expect((await cast(0)).statusCode).toBe(200);
    });

    it('refuses new votes once the time is up or the cloud is locked, and says why', async () => {
      await setClosesAt(Date.now() - 1);
      const res = await cast(0);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'voting_closed' });
      expect(publishEvent).not.toHaveBeenCalled();
      const votes = await createDb().execute('SELECT COUNT(*) AS n FROM votes');
      expect(Number(votes.rows[0].n)).toBe(0);
    });

    it('also refuses a change to an answer that was already given', async () => {
      expect((await cast(0)).statusCode).toBe(200);
      await setClosesAt(Date.now() - 1);
      expect((await cast(1)).statusCode).toBe(409);
      const row = (await createDb().execute('SELECT value FROM votes')).rows[0];
      expect(row.value).toBe('0');
    });

    it('takes votes again once the cloud is unlocked', async () => {
      await setClosesAt(Date.now() - 1);
      expect((await cast(0)).statusCode).toBe(409);
      await setClosesAt(null);
      expect((await cast(0)).statusCode).toBe(200);
    });
  });

  it('refuses a vote on a content cloud and writes no row', async () => {
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, created_at) VALUES (3, 'STORM01', 2, 'content', 'Read this', ?)`,
      args: [Date.now()],
    });
    await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 3', args: [] });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 3, deviceId: 'dev-content', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'This cloud takes no votes', code: 'no_votes' });
    expect(publishEvent).not.toHaveBeenCalled();
    const votes = await db.execute('SELECT COUNT(*) AS n FROM votes');
    expect(Number(votes.rows[0].n)).toBe(0);
  });

  it('refuses a vote on a locked or timed-out content cloud with voting_closed, not no_votes', async () => {
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, closes_at, created_at) VALUES (3, 'STORM01', 2, 'content', 'Read this', ?, ?)`,
      args: [Date.now() - 1, Date.now()],
    });
    await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 3', args: [] });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 3, deviceId: 'dev-content', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'voting_closed' });
  });

  describe('word cloud', () => {
    beforeEach(async () => {
      const db = createDb();
      await db.execute({
        sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, max_words, created_at) VALUES (5, 'STORM01', 4, 'words', 'One word', 2, ?)`,
        args: [Date.now()],
      });
      await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 5', args: [] });
    });

    const send = (deviceId, value) => handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 5, deviceId, value }),
    });
    const rows = async () => (await createDb().execute('SELECT * FROM votes WHERE cloud_id = 5')).rows;

    it('cleans the words, stores them as a list and returns them', async () => {
      const res = await send('w1', ['Team!', 'work']);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).words).toEqual(['team', 'work']);
      expect((await rows())[0].value).toBe('["team","work"]');
    });

    it('refuses more words than allowed and writes nothing', async () => {
      const res = await send('w1', ['a', 'b', 'c']);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('You can send at most 2 words');
      expect(await rows()).toHaveLength(0);
    });

    it('replaces the words a device sent before', async () => {
      await send('w1', ['a']);
      await send('w1', ['b']);
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].value).toBe('["b"]');
    });

    it('refuses a plain number', async () => {
      expect((await send('w1', 3)).statusCode).toBe(400);
    });

    it('counts two devices that sent the same word and publishes the tally', async () => {
      await send('w1', ['team']);
      const res = await send('w2', ['Team']);
      expect(JSON.parse(res.body).tally).toEqual({ words: [{ word: 'team', count: 2 }], totalVotes: 2 });
      expect(publishEvent).toHaveBeenLastCalledWith('STORM01', 'tally', expect.objectContaining({ cloudId: 5, words: [{ word: 'team', count: 2 }] }));
    });

    it('accepts a hidden word but leaves it out of the tally while still counting the sender', async () => {
      await createDb().execute({ sql: `UPDATE clouds SET hidden_words = '["team"]' WHERE id = 5`, args: [] });
      const res = await send('w1', ['team']);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tally).toEqual({ words: [], totalVotes: 1 });
    });

    it('refuses an oversized request body and writes nothing', async () => {
      const res = await send('w1', ['a'.repeat(9000)]);
      expect(res.statusCode).toBe(413);
      expect(await rows()).toHaveLength(0);
    });

    it('refuses once the cloud is locked', async () => {
      await createDb().execute({ sql: 'UPDATE clouds SET closes_at = ? WHERE id = 5', args: [Date.now() - 1] });
      const res = await send('w1', ['a']);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('voting_closed');
    });

    it('refuses words for a words cloud that is not the live one, and writes nothing', async () => {
      await createDb().execute({ sql: 'UPDATE storms SET current_cloud_id = 1', args: [] });
      const res = await send('w1', ['team']);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('not_active');
      expect(await rows()).toHaveLength(0);
    });

    it('publishes the stored numeric id even when the request sent the id as a string', async () => {
      const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ stormCode: 'STORM01', cloudId: '5', deviceId: 'w1', value: ['team'] }) });
      expect(res.statusCode).toBe(200);
      expect(publishEvent).toHaveBeenLastCalledWith('STORM01', 'tally', expect.objectContaining({ cloudId: 5 }));
    });
  });

  it('records a vote and publishes a tally', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-a', value: 0 }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tally.counts).toEqual([1, 0]);
    expect(publishEvent).toHaveBeenCalledWith('STORM01', 'tally', expect.objectContaining({ cloudId: 1 }));
  });

  describe('multi-select cloud', () => {
    beforeEach(async () => {
      const db = createDb();
      await db.execute({
        sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, multi, created_at) VALUES (2, 'STORM01', 1, 'choice', 'Pick any', ?, 1, ?)`,
        args: [JSON.stringify(['A', 'B', 'C']), Date.now()],
      });
      await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 2', args: [] });
    });

    const vote = (deviceId, value) => handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 2, deviceId, value }),
    });

    it('tallies each selected option once per person and counts people as the total', async () => {
      await vote('d1', [0, 2]);
      const res = await vote('d2', [2]);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tally).toEqual({ counts: [1, 0, 2], totalVotes: 2 });
    });

    it('rejects non-array, empty, out-of-range and non-integer selections', async () => {
      for (const bad of [1, [], [3], [-1], [0.5], ['x']]) {
        expect((await vote('d1', bad)).statusCode).toBe(400);
      }
    });

    it('de-duplicates repeated picks and lets a device replace its selection', async () => {
      const res = await vote('d1', [1, 1]);
      expect(JSON.parse(res.body).tally.counts).toEqual([0, 1, 0]);
      const changed = await vote('d1', [0]);
      expect(changed.statusCode).toBe(200);
      expect(JSON.parse(changed.body).tally).toEqual({ counts: [1, 0, 0], totalVotes: 1 });
    });

    it('single-choice clouds still reject arrays', async () => {
      const db = createDb();
      await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 1', args: [] });
      const res = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'd9', value: [0, 1] }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('lets a device change its vote: the new choice replaces the old and the total stays 1', async () => {
    await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-a', value: 0 }),
    });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-a', value: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tally).toEqual({ counts: [0, 1], totalVotes: 1 });
  });

  it('rejects a vote for a cloud that is not currently active', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 99, deviceId: 'dev-b', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a vote when storm status is not active, even if cloud ID matches', async () => {
    // Update the existing storm to status='lobby' while keeping current_cloud_id=1
    const db = createDb();
    await db.execute({
      sql: 'UPDATE storms SET status = ? WHERE storm_code = ?',
      args: ['lobby', 'STORM01'],
    });

    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-c', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('reports code not_active on a 409 for an inactive cloud', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 99, deviceId: 'dev-code', value: 0 }),
    });
    expect(JSON.parse(res.body).code).toBe('not_active');
  });

  it('withholds counts from the response and the published tally while results are hidden', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE clouds SET results_hidden = 1 WHERE id = 1', args: [] });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-h', value: 0 }),
    });
    expect(JSON.parse(res.body).tally).toEqual({ totalVotes: 1, hidden: true });
    expect(publishEvent).toHaveBeenCalledWith('STORM01', 'tally', { cloudId: 1, totalVotes: 1, hidden: true });
  });

  it('rejects an out-of-range choice vote value', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-oob', value: 2 }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid vote value' });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('rejects a negative choice vote value', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-neg', value: -1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid vote value' });
  });

  it('rejects an out-of-range rating vote value', async () => {
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, scale_min, scale_max, created_at) VALUES (2, 'STORM01', 1, 'rating', 'Rate it', 1, 5, ?)`,
      args: [Date.now()],
    });
    await db.execute({
      sql: 'UPDATE storms SET current_cloud_id = ? WHERE storm_code = ?',
      args: [2, 'STORM01'],
    });

    const tooHigh = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 2, deviceId: 'dev-rate-a', value: 6 }),
    });
    expect(tooHigh.statusCode).toBe(400);
    expect(JSON.parse(tooHigh.body)).toEqual({ error: 'Invalid vote value' });

    const tooLow = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 2, deviceId: 'dev-rate-b', value: 0 }),
    });
    expect(tooLow.statusCode).toBe(400);
    expect(JSON.parse(tooLow.body)).toEqual({ error: 'Invalid vote value' });

    const ok = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ stormCode: 'STORM01', cloudId: 2, deviceId: 'dev-rate-c', value: 3 }),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('does not report a 409 (already voted) for a non-constraint DB error on the vote insert', async () => {
    // Simulate a transient DB failure (e.g. a dropped connection) on the
    // vote INSERT specifically, while every other query on this connection
    // still behaves normally. The narrowed catch in vote.js must NOT treat
    // this as a duplicate-vote 409 — it should propagate as an error.
    const realDb = createDb();
    createDb.mockImplementationOnce(() => ({
      execute: async (query) => {
        const sql = typeof query === 'string' ? query : query.sql;
        if (typeof sql === 'string' && sql.includes('INSERT INTO votes')) {
          const err = new Error('Connection reset by peer');
          err.code = 'ECONNRESET';
          throw err;
        }
        return realDb.execute(query);
      },
    }));

    await expect(
      handler({
        httpMethod: 'POST',
        body: JSON.stringify({ stormCode: 'STORM01', cloudId: 1, deviceId: 'dev-crash', value: 0 }),
      })
    ).rejects.toThrow(/connection reset/i);
  });
});
