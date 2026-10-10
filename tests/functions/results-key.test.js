import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { publishEvent } from '../../lib/realtime.js';
import { createDb, initSchema } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { handler as clouds } from '../../netlify/functions/admin-clouds.js';
import { handler as resolveKey } from '../../netlify/functions/resolve-results-key.js';
import { handler as activate } from '../../netlify/functions/results-activate.js';

describe('results key', () => {
  let admin;
  let stormCode;
  let resultsKey;
  let q1;
  let q2;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
    stormCode = admin.stormCode;
    resultsKey = admin.resultsKey;
    const add = async (body) => JSON.parse((await admin.call(clouds, 'admin-clouds', {
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body, options: ['A', 'B'] }),
    })).body).id;
    q1 = await add('One');
    q2 = await add('Two');
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  const resolve = (key) => resolveKey({ httpMethod: 'GET', queryStringParameters: { key } });
  const go = (body) => activate({ httpMethod: 'POST', body: JSON.stringify(body) });

  it('resolves a results key to its storm and rejects a plain storm code', async () => {
    expect(JSON.parse((await resolve(resultsKey)).body)).toEqual({ stormCode, resultsBackground: null });
    expect((await resolve(stormCode)).statusCode).toBe(404);
    expect((await resolve('nonsense')).statusCode).toBe(404);
  });

  it('passes the presenter\'s results background colour along, so pinned links open in it', async () => {
    await admin.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', body: JSON.stringify({ resultsBackground: '#102030' }) });
    expect(JSON.parse((await resolve(resultsKey)).body)).toEqual({ stormCode, resultsBackground: '#102030' });
  });

  it('makes a cloud live from the results key and publishes the state', async () => {
    const res = await go({ resultsKey, cloudId: q2 });
    expect(JSON.parse(res.body)).toEqual({ ok: true, changed: true });
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      status: 'active',
      currentCloud: expect.objectContaining({ id: q2, body: 'Two' }),
    }));
    const body = JSON.parse((await admin.call(adminStorm, 'admin-storm', { httpMethod: 'GET' })).body);
    expect(body.storm.current_cloud_id).toBe(q2);
  });

  it('brings a cloud live open, even if it was locked before', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE clouds SET closes_at = ? WHERE id = ?', args: [Date.now() - 1000, q2] });
    await go({ resultsKey, cloudId: q2 });
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      currentCloud: expect.objectContaining({ id: q2, votingMsLeft: null }),
    }));
    expect((await db.execute({ sql: 'SELECT closes_at FROM clouds WHERE id = ?', args: [q2] })).rows[0].closes_at).toBeNull();
  });

  it('does nothing (and publishes nothing) when the cloud is already live', async () => {
    await go({ resultsKey, cloudId: q1 });
    vi.clearAllMocks();
    expect(JSON.parse((await go({ resultsKey, cloudId: q1 })).body).changed).toBe(false);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('never reopens a closed storm', async () => {
    await admin.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
    vi.clearAllMocks();
    const res = await go({ resultsKey, cloudId: q2 });
    expect(JSON.parse(res.body)).toMatchObject({ changed: false, closed: true });
    expect(publishEvent).not.toHaveBeenCalled();
    const body = JSON.parse((await admin.call(adminStorm, 'admin-storm', { httpMethod: 'GET' })).body);
    expect(body.storm.status).toBe('closed');
    expect(body.storm.current_cloud_id).not.toBe(q2);
  });

  it('refuses a storm code, a wrong key, or a cloud from another storm', async () => {
    expect((await go({ resultsKey: stormCode, cloudId: q1 })).statusCode).toBe(401);
    expect((await go({ resultsKey: 'f'.repeat(24), cloudId: q1 })).statusCode).toBe(401);
    expect((await go({ resultsKey, cloudId: 99999 })).statusCode).toBe(404);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
