import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler } from '../../netlify/functions/get-storm-state.js';

describe('get-storm-state function', () => {
  let stormCode;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    stormCode = (await seedStorm(db, { status: 'active', current_cloud_id: 1 })).stormCode;
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (1, ?, 0, 'choice', 'Pick one', ?, ?)`,
      args: [stormCode, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (1, ?, ?, ?)',
      args: ['dev-1', '0', Date.now()],
    });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns the current cloud and tally', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    const body = JSON.parse(res.body);
    expect(body.currentCloud.body).toBe('Pick one');
    expect(body.tally.counts).toEqual([1, 0]);
  });

  it('returns a live word cloud with its limit and a tally without hidden words', async () => {
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, max_words, hidden_words, created_at) VALUES (7, ?, 1, 'words', 'One word', 4, '["rude"]', ?)`,
      args: [stormCode, Date.now()],
    });
    await db.execute({ sql: 'UPDATE storms SET current_cloud_id = 7 WHERE storm_code = ?', args: [stormCode] });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (7, ?, ?, ?)', args: ['d1', '["rude","nice"]', Date.now()] });
    const body = JSON.parse((await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } })).body);
    expect(body.currentCloud).toMatchObject({ kind: 'words', maxWords: 4 });
    expect(body.tally).toEqual({ words: [{ word: 'nice', count: 1 }], totalVotes: 1 });
  });

  it('404s for an unknown storm', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode: 'NOPE00' } });
    expect(res.statusCode).toBe(404);
  });

  it('reports showConnect: false while a cloud is live, true once the presenter overrides it', async () => {
    let res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(JSON.parse(res.body).showConnect).toBe(false);
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET show_connect = 1 WHERE storm_code = ?', args: [stormCode] });
    res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('reports showConnect: true for a lobby with no current cloud', async () => {
    const db = createDb();
    await db.execute({ sql: "UPDATE storms SET current_cloud_id = NULL, status = 'lobby' WHERE storm_code = ?", args: [stormCode] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('returns a clean 404 (not a 500) against a completely fresh database with no tables yet', async () => {
    // Point at a brand-new SQLite file that has never had initSchema() run
    // against it. Without the fix, this throws an unhandled
    // "no such table: storms" instead of the intended 404.
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-fresh-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'fresh.db')}`;

    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode: 'ANY000' } });
    expect(res.statusCode).toBe(404);
  });

  it('reports nothing live, instead of crashing, when the current cloud has been removed', async () => {
    const db = createDb();
    await db.execute({ sql: 'DELETE FROM votes', args: [] });
    await db.execute({ sql: 'DELETE FROM clouds', args: [] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'active', currentCloud: null, tally: null });
  });
});

describe('functions on a database from before clouds', () => {
  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  // Netlify answers a handler that throws with a 500 and logs the message, so the owner sees what to do.
  it('fail at once with the clear message instead of hanging or a confusing error', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const old = createDb();
    await old.execute("CREATE TABLE storms (admin_key_hash TEXT PRIMARY KEY, storm_code TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'lobby', current_question_id INTEGER, created_at INTEGER NOT NULL)");
    await old.execute('CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, device_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const { handler: vote } = await import('../../netlify/functions/vote.js');
    const message = 'This database is from before clouds: drop the storms, questions and votes tables, then try again.';
    await expect(handler({ httpMethod: 'GET', queryStringParameters: { stormCode: 'ABCDEFGH' } })).rejects.toThrow(message);
    await expect(
      vote({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ stormCode: 'ABCDEFGH', cloudId: 1, deviceId: 'device-1', value: 0 }) }),
    ).rejects.toThrow(message);
  }, 5000);
});
