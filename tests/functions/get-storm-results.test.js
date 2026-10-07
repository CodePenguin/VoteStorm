import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { generateAdminKey, hashAdminKey, deriveStormCode } from '../../lib/stormCode.js';
import { handler } from '../../netlify/functions/get-storm-results.js';

describe('get-storm-results function', () => {
  let stormCode;
  let db;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    const adminKey = generateAdminKey();
    stormCode = deriveStormCode(adminKey);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_json) VALUES (?, ?, 'closed', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: [hashAdminKey(adminKey), stormCode, Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, options, created_at) VALUES (1, ?, 0, 'choice', 'Pick one', ?, ?)`,
      args: [stormCode, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, scale_min, scale_max, created_at) VALUES (2, ?, 1, 'rating', 'Rate it', 1, 5, ?)`,
      args: [stormCode, Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d1', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d2', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (2, ?, ?, ?)', args: ['d1', '4', Date.now()] });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns every question in order with its tally when the storm is closed', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    const { questions } = JSON.parse(res.body);
    expect(questions.map((q) => q.prompt)).toEqual(['Pick one', 'Rate it']);
    expect(questions[0]).toMatchObject({ id: 1, type: 'choice', options: ['A', 'B'], tally: { counts: [2, 0], totalVotes: 2 } });
    expect(questions[1]).toMatchObject({ id: 2, type: 'rating', scaleMin: 1, scaleMax: 5, options: null });
    expect(questions[1].tally.average).toBe(4);
  });

  it('includes questions that have zero votes', async () => {
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, options, created_at) VALUES (3, ?, 2, 'choice', 'Empty', ?, ?)`,
      args: [stormCode, JSON.stringify(['X', 'Y']), Date.now()],
    });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    const { questions } = JSON.parse(res.body);
    expect(questions[2].tally).toEqual({ counts: [0, 0], totalVotes: 0 });
  });

  it('returns an empty list for a closed storm with no questions', async () => {
    await db.execute({ sql: 'DELETE FROM votes', args: [] });
    await db.execute({ sql: 'DELETE FROM questions', args: [] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ questions: [] });
  });

  it('refuses with 403 and no results while the storm is still open', async () => {
    await db.execute({ sql: `UPDATE storms SET status = 'active' WHERE storm_code = ?`, args: [stormCode] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { stormCode } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).questions).toBeUndefined();
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
