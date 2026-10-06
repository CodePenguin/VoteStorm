import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handler } from '../../netlify/functions/create-storm.js';
import { createDb, initSchema, getStormByCode } from '../../lib/db.js';

describe('create-storm function', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('creates a storm and returns adminKey + stormCode', async () => {
    const res = await handler({ httpMethod: 'POST' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.adminKey).toMatch(/^[0-9a-f]{48}$/);
    expect(body.stormCode).toHaveLength(6);
  });

  it('rejects non-POST methods', async () => {
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(405);
  });

  it('sets last_activity_at to now and the default 24-hour window on the new storm', async () => {
    const res = await handler({ httpMethod: 'POST' });
    const { stormCode } = JSON.parse(res.body);

    const db = createDb();
    const storm = await getStormByCode(db, stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
    expect(Number(storm.inactivity_hours)).toBe(24);
    expect(storm.license_id).toBeNull();
  });

  it('sweeps storms inactive for more than 24 hours when a new storm is created', async () => {
    const db = createDb();
    await initSchema(db);

    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, last_activity_at) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['stale-hash', 'STALE1', Date.now(), Date.now() - 25 * 3600000],
    });

    await handler({ httpMethod: 'POST' });

    const gone = await db.execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: ['STALE1'] });
    expect(gone.rows).toHaveLength(0);
  });

  it('does not sweep storms active within the last 24 hours', async () => {
    const db = createDb();
    await initSchema(db);

    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, last_activity_at) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['fresh-hash', 'FRESH1', Date.now(), Date.now() - 3600000],
    });

    await handler({ httpMethod: 'POST' });

    expect(await getStormByCode(db, 'FRESH1')).not.toBeNull();
  });
});
