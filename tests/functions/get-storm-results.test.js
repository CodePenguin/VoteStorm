import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler } from '../../netlify/functions/get-storm-results.js';

describe('get-storm-results function', () => {
  let stormCode;
  let db;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    stormCode = (await seedStorm(db, { status: 'closed' })).stormCode;
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (1, ?, 0, 'choice', 'Pick one', ?, ?)`,
      args: [stormCode, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, scale_min, scale_max, created_at) VALUES (2, ?, 1, 'rating', 'Rate it', 1, 5, ?)`,
      args: [stormCode, Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d1', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d2', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (2, ?, ?, ?)', args: ['d1', '4', Date.now()] });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns every cloud in order with its tally when the storm is closed', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    const { clouds } = JSON.parse(res.body);
    expect(clouds.map((q) => q.body)).toEqual(['Pick one', 'Rate it']);
    expect(clouds[0]).toMatchObject({ id: 1, kind: 'choice', options: ['A', 'B'], tally: { counts: [2, 0], totalVotes: 2 } });
    expect(clouds[1]).toMatchObject({ id: 2, kind: 'rating', scaleMin: 1, scaleMax: 5, options: null });
    expect(clouds[1].tally.average).toBe(4);
  });

  it('returns a content cloud in order with an empty tally', async () => {
    await db.execute({ sql: 'DELETE FROM clouds WHERE id = 2', args: [] });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, created_at) VALUES (4, ?, 1, 'content', '# Read this', ?)`,
      args: [stormCode, Date.now()],
    });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    const { clouds } = JSON.parse(res.body);
    expect(clouds.map((q) => q.kind)).toEqual(['choice', 'content']);
    expect(clouds[1]).toMatchObject({ id: 4, body: '# Read this', tally: { counts: [], totalVotes: 0 } });
  });

  it('returns a word cloud with its limit and a tally without hidden words', async () => {
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, max_words, hidden_words, created_at) VALUES (5, ?, 2, 'words', 'One word', 4, '["rude"]', ?)`,
      args: [stormCode, Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (5, ?, ?, ?)', args: ['d1', '["rude","nice"]', Date.now()] });
    const { clouds } = JSON.parse((await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } })).body);
    const words = clouds.find((q) => q.id === 5);
    expect(words).toMatchObject({ kind: 'words', maxWords: 4, tally: { words: [{ word: 'nice', count: 1 }], totalVotes: 1 } });
  });

  it('includes clouds that have zero votes', async () => {
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (3, ?, 2, 'choice', 'Empty', ?, ?)`,
      args: [stormCode, JSON.stringify(['X', 'Y']), Date.now()],
    });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    const { clouds } = JSON.parse(res.body);
    expect(clouds[2].tally).toEqual({ counts: [0, 0], totalVotes: 0 });
  });

  it('returns an empty list for a closed storm with no clouds', async () => {
    await db.execute({ sql: 'DELETE FROM votes', args: [] });
    await db.execute({ sql: 'DELETE FROM clouds', args: [] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ clouds: [] });
  });

  it('refuses with 403 and no results while the storm is still open', async () => {
    await db.execute({ sql: `UPDATE storms SET status = 'active' WHERE storm_code = ?`, args: [stormCode] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).clouds).toBeUndefined();
  });

  it('404s for an unknown storm', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode: 'NOPE00' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s without a stormCode and 405s for non-GET', async () => {
    expect((await handler({ httpMethod: 'GET', queryStringParameters: {} })).statusCode).toBe(400);
    expect((await handler({ httpMethod: 'POST', queryStringParameters: { stormCode } })).statusCode).toBe(405);
  });
});
