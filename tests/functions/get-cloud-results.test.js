import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler } from '../../netlify/functions/get-cloud-results.js';

describe('get-cloud-results function', () => {
  let db;
  let storm1;
  let storm2;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    storm1 = (await seedStorm(db, { status: 'active' })).stormCode;
    storm2 = (await seedStorm(db, { status: 'active' })).stormCode;
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, correct, created_at) VALUES (1, ?, 0, 'choice', 'Pick', ?, '[1]', ?)`,
      args: [storm1, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (2, ?, 0, 'choice', 'Other storm', ?, ?)`,
      args: [storm2, JSON.stringify(['X', 'Y']), Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d1', '1', Date.now()] });
    await db.execute({ sql: `UPDATE storms SET current_cloud_id = 1 WHERE storm_code = ?`, args: [storm1] });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  const get = (q) => handler({ httpMethod: 'GET', queryStringParameters: q });

  it('returns the live cloud and its tally, keeping the correct answer private', async () => {
    const res = await get({ stormCode: storm1, cloudId: '1' });
    const body = JSON.parse(res.body);
    expect(body.cloud).toMatchObject({ id: 1, body: 'Pick', correct: null, resultsHidden: false });
    expect(body.tally).toEqual({ counts: [0, 1], totalVotes: 1 });
  });

  it('reveals the correct answer once the presenter has shown it', async () => {
    await db.execute({ sql: 'UPDATE clouds SET answer_shown = 1 WHERE id = 1', args: [] });
    const body = JSON.parse((await get({ stormCode: storm1, cloudId: '1' })).body);
    expect(body.cloud.correct).toEqual([1]);
  });

  it('withholds counts while the cloud results are hidden', async () => {
    await db.execute({ sql: 'UPDATE clouds SET results_hidden = 1 WHERE id = 1', args: [] });
    const body = JSON.parse((await get({ stormCode: storm1, cloudId: '1' })).body);
    expect(body.tally).toEqual({ totalVotes: 1, hidden: true });
  });

  it('sends no cloud or counts when the cloud is not the live one', async () => {
    await db.execute({ sql: `UPDATE storms SET current_cloud_id = NULL WHERE storm_code = ?`, args: [storm1] });
    const body = JSON.parse((await get({ stormCode: storm1, cloudId: '1' })).body);
    expect(body).toEqual({ status: 'active', live: false, cloud: null, tally: null });
  });

  it('shows the cloud with everything revealed once the storm is closed', async () => {
    await db.execute({ sql: `UPDATE storms SET status = 'closed', current_cloud_id = NULL WHERE storm_code = ?`, args: [storm1] });
    const body = JSON.parse((await get({ stormCode: storm1, cloudId: '1' })).body);
    expect(body.live).toBe(false);
    expect(body.cloud).toMatchObject({ body: 'Pick', correct: [1] });
    expect(body.tally.counts).toEqual([0, 1]);
  });

  it('does not serve a cloud from a different storm', async () => {
    expect((await get({ stormCode: storm1, cloudId: '2' })).statusCode).toBe(404);
    expect((await get({ stormCode: 'NOPE00', cloudId: '1' })).statusCode).toBe(404);
    expect((await get({ stormCode: storm1 })).statusCode).toBe(400);
  });
});
