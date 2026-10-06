import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { generateAdminKey, hashAdminKey, deriveStormCode } from '../../lib/stormCode.js';
import { handler } from '../../netlify/functions/get-storm-state.js';

describe('get-storm-state function', () => {
  let stormCode;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    const adminKey = generateAdminKey();
    stormCode = deriveStormCode(adminKey);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, current_question_id, created_at) VALUES (?, ?, 'active', 1, ?)`,
      args: [hashAdminKey(adminKey), stormCode, Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, options, created_at) VALUES (1, ?, 0, 'choice', 'Pick one', ?, ?)`,
      args: [stormCode, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)',
      args: ['dev-1', '0', Date.now()],
    });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns the current question and tally', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    const body = JSON.parse(res.body);
    expect(body.currentQuestion.prompt).toBe('Pick one');
    expect(body.tally.counts).toEqual([1, 0]);
  });

  it('404s for an unknown storm', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode: 'NOPE00' } });
    expect(res.statusCode).toBe(404);
  });

  it('reports showConnect: false while a question is live, true once the presenter overrides it', async () => {
    let res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(JSON.parse(res.body).showConnect).toBe(false);
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET show_connect = 1 WHERE storm_code = ?', args: [stormCode] });
    res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('reports showConnect: true for a lobby with no current question', async () => {
    const db = createDb();
    await db.execute({ sql: "UPDATE storms SET current_question_id = NULL, status = 'lobby' WHERE storm_code = ?", args: [stormCode] });
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

  it('reports nothing live, instead of crashing, when the current question has been removed', async () => {
    const db = createDb();
    await db.execute({ sql: 'DELETE FROM votes', args: [] });
    await db.execute({ sql: 'DELETE FROM questions', args: [] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'active', currentQuestion: null, tally: null });
  });
});
