import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(async (stormCode) => ({ keyName: 'fake', capability: `{"storm:${stormCode}":["subscribe"]}` })),
}));

import { createTokenRequest } from '../../lib/realtime.js';
import { createDb, initSchema } from '../../lib/db.js';
import { handler } from '../../netlify/functions/ably-token.js';

describe('ably-token function', () => {
  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash1', 'STORM01', Date.now()],
    });
    createTokenRequest.mockClear();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.RATE_LIMIT_SCALE;
  });

  const get = (query, headers = {}) => handler({ httpMethod: 'GET', queryStringParameters: query, headers });

  it('returns a token request scoped to the storm channel', async () => {
    const res = await get({ stormCode: 'STORM01' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.capability).toContain('storm:STORM01');
  });

  it('passes a valid clientId through and ignores a malformed one', async () => {
    await get({ stormCode: 'STORM01', clientId: 'abc-123' });
    expect(createTokenRequest).toHaveBeenLastCalledWith('STORM01', 'abc-123');
    await get({ stormCode: 'STORM01', clientId: 'bad id!*' });
    expect(createTokenRequest).toHaveBeenLastCalledWith('STORM01', undefined);
  });

  it('requires stormCode', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(400);
  });

  it('only issues tokens for storms that exist, so channel names cannot be made up', async () => {
    const res = await get({ stormCode: 'NOPE99' });
    expect(res.statusCode).toBe(404);
    expect(createTokenRequest).not.toHaveBeenCalled();
  });

  it('refuses anything but GET', async () => {
    expect((await handler({ httpMethod: 'POST', headers: {} })).statusCode).toBe(405);
  });

  it('rate limits tokens per address, telling the caller when to retry', async () => {
    process.env.RATE_LIMIT_SCALE = '0.005'; // 600/min becomes 3/min
    const ip = { 'x-nf-client-connection-ip': '203.0.113.9' };
    for (let i = 0; i < 3; i++) expect((await get({ stormCode: 'STORM01' }, ip)).statusCode).toBe(200);
    const blocked = await get({ stormCode: 'STORM01' }, ip);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(blocked.body).code).toBe('rate_limited');
    expect((await get({ stormCode: 'STORM01' }, { 'x-nf-client-connection-ip': '203.0.113.10' })).statusCode).toBe(200);
  });
});
