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
import { handler } from '../../netlify/functions/vote.js';

describe('vote function', () => {
  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, current_question_id, created_at) VALUES (?, ?, 'active', 1, ?)`,
      args: ['hash1', 'ROOM01', Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (1, 'ROOM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('records a vote and publishes a tally', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 0 }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tally.counts).toEqual([1, 0]);
    expect(publishEvent).toHaveBeenCalledWith('ROOM01', 'tally', expect.objectContaining({ questionId: 1 }));
  });

  describe('multi-select question', () => {
    beforeEach(async () => {
      const db = createDb();
      await db.execute({
        sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, multi, created_at) VALUES (2, 'ROOM01', 1, 'choice', 'Pick any', ?, 1, ?)`,
        args: [JSON.stringify(['A', 'B', 'C']), Date.now()],
      });
      await db.execute({ sql: 'UPDATE rooms SET current_question_id = 2', args: [] });
    });

    const vote = (deviceId, value) => handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 2, deviceId, value }),
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

    it('single-choice questions still reject arrays', async () => {
      const db = createDb();
      await db.execute({ sql: 'UPDATE rooms SET current_question_id = 1', args: [] });
      const res = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'd9', value: [0, 1] }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('lets a device change its vote: the new choice replaces the old and the total stays 1', async () => {
    await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 0 }),
    });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tally).toEqual({ counts: [0, 1], totalVotes: 1 });
  });

  it('rejects a vote for a question that is not currently active', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 99, deviceId: 'dev-b', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a vote when room status is not active, even if question ID matches', async () => {
    // Update the existing room to status='lobby' while keeping current_question_id=1
    const db = createDb();
    await db.execute({
      sql: 'UPDATE rooms SET status = ? WHERE room_code = ?',
      args: ['lobby', 'ROOM01'],
    });

    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-c', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('reports code not_active on a 409 for an inactive question', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 99, deviceId: 'dev-code', value: 0 }),
    });
    expect(JSON.parse(res.body).code).toBe('not_active');
  });

  it('withholds counts from the response and the published tally while results are hidden', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE questions SET results_hidden = 1 WHERE id = 1', args: [] });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-h', value: 0 }),
    });
    expect(JSON.parse(res.body).tally).toEqual({ totalVotes: 1, hidden: true });
    expect(publishEvent).toHaveBeenCalledWith('ROOM01', 'tally', { questionId: 1, totalVotes: 1, hidden: true });
  });

  it('rejects an out-of-range choice vote value', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-oob', value: 2 }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid vote value' });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('rejects a negative choice vote value', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-neg', value: -1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid vote value' });
  });

  it('rejects an out-of-range rating vote value', async () => {
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, scale_min, scale_max, created_at) VALUES (2, 'ROOM01', 1, 'rating', 'Rate it', 1, 5, ?)`,
      args: [Date.now()],
    });
    await db.execute({
      sql: 'UPDATE rooms SET current_question_id = ? WHERE room_code = ?',
      args: [2, 'ROOM01'],
    });

    const tooHigh = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 2, deviceId: 'dev-rate-a', value: 6 }),
    });
    expect(tooHigh.statusCode).toBe(400);
    expect(JSON.parse(tooHigh.body)).toEqual({ error: 'Invalid vote value' });

    const tooLow = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 2, deviceId: 'dev-rate-b', value: 0 }),
    });
    expect(tooLow.statusCode).toBe(400);
    expect(JSON.parse(tooLow.body)).toEqual({ error: 'Invalid vote value' });

    const ok = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 2, deviceId: 'dev-rate-c', value: 3 }),
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
        body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-crash', value: 0 }),
      })
    ).rejects.toThrow(/connection reset/i);
  });
});
