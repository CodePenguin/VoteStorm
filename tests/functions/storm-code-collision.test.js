import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/stormCode.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateAdminKey: vi.fn(actual.generateAdminKey) };
});

import { generateAdminKey, deriveStormCode } from '../../lib/stormCode.js';
import { createDb, initSchema } from '../../lib/db.js';
import { handler } from '../../netlify/functions/create-storm.js';

describe('storm code collisions', () => {
  let db;
  const takenKey = 'a'.repeat(48);
  const freshKey = 'b'.repeat(48);

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    // Another storm already holds the short code that takenKey would produce.
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, last_activity_at, license_json) VALUES (?, ?, 'lobby', ?, ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['someone-elses-hash', deriveStormCode(takenKey), Date.now(), Date.now()],
    });
    generateAdminKey.mockReset();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('draws another key when the short code is already in use', async () => {
    generateAdminKey.mockReturnValueOnce(takenKey).mockReturnValueOnce(freshKey);
    const res = await handler({ httpMethod: 'POST', headers: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.adminKey).toBe(freshKey);
    expect(body.stormCode).toBe(deriveStormCode(freshKey));
    expect(generateAdminKey).toHaveBeenCalledTimes(2);
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(2);
  });

  it('gives up with a clear message, instead of an error, if it keeps colliding', async () => {
    generateAdminKey.mockReturnValue(takenKey);
    const res = await handler({ httpMethod: 'POST', headers: {} });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Could not allocate a Storm code');
    expect(generateAdminKey).toHaveBeenCalledTimes(5);
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(1);
  });
});
