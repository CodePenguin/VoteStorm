import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema, sweepExpiredStorms } from '../../lib/db.js';
import { LIMITS, clientIp, rateLimit } from '../../lib/rateLimit.js';

async function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
  const db = createDb(`file:${path.join(dir, 'test.db')}`);
  await initSchema(db);
  return db;
}

const env = (scale) => ({ RATE_LIMIT_SCALE: scale });
const MINUTE = 60000;

describe('rate limiting', () => {
  it('lets requests through up to the limit, then answers 429 with when to retry', async () => {
    const db = await freshDb();
    const opts = { env: env('0.015'), now: 10 * MINUTE + 5000 }; // 2000/min becomes 30
    const limit = Math.floor(LIMITS.voteByIp.limit * 0.015);
    for (let i = 0; i < limit; i++) expect(await rateLimit(db, 'voteByIp', '198.51.100.1', opts)).toBeNull();
    const blocked = await rateLimit(db, 'voteByIp', '198.51.100.1', opts);
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body)).toMatchObject({ code: 'rate_limited' });
    expect(blocked.headers['retry-after']).toBe('55');
  });

  it('counts each address and each rule separately', async () => {
    const db = await freshDb();
    const opts = { env: env('0.0005'), now: 0 }; // everything allows just 1 per window
    expect(await rateLimit(db, 'voteByIp', 'a', opts)).toBeNull();
    expect((await rateLimit(db, 'voteByIp', 'a', opts)).statusCode).toBe(429);
    expect(await rateLimit(db, 'voteByIp', 'b', opts)).toBeNull();
    expect(await rateLimit(db, 'realtimeToken', 'a', opts)).toBeNull();
  });

  it('starts counting again in the next window', async () => {
    const db = await freshDb();
    const opts = { env: env('0.0005') };
    expect(await rateLimit(db, 'voteByIp', 'a', { ...opts, now: 0 })).toBeNull();
    expect((await rateLimit(db, 'voteByIp', 'a', { ...opts, now: 1000 })).statusCode).toBe(429);
    expect(await rateLimit(db, 'voteByIp', 'a', { ...opts, now: MINUTE + 1 })).toBeNull();
  });

  it('can be scaled up, and switched off with a scale of 0', async () => {
    const db = await freshDb();
    expect(await rateLimit(db, 'voteByIp', 'a', { env: env('0'), now: 0 })).toBeNull();
    for (let i = 0; i < 10; i++) expect(await rateLimit(db, 'voteByIp', 'a', { env: env('0'), now: 0 })).toBeNull();
    const rows = await db.execute('SELECT COUNT(*) AS n FROM rate_limits');
    expect(Number(rows.rows[0].n)).toBe(0);
    const generous = { env: env('1000'), now: 0 };
    for (let i = 0; i < 50; i++) expect(await rateLimit(db, 'voteByIp', 'b', generous)).toBeNull();
  });

  it('does nothing when the caller cannot be identified (local development)', async () => {
    const db = await freshDb();
    expect(await rateLimit(db, 'createStorm', null, { env: env('0.0001') })).toBeNull();
    expect(await rateLimit(db, 'createStorm', undefined, { env: env('0.0001') })).toBeNull();
  });

  it('stores only a hash of the address', async () => {
    const db = await freshDb();
    await rateLimit(db, 'voteByIp', '203.0.113.77', { now: 0 });
    const rows = (await db.execute('SELECT bucket FROM rate_limits')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).not.toContain('203.0.113.77');
    expect(rows[0].bucket).toMatch(/^voteByIp:[0-9a-f]{20}$/);
  });

  it('forgets old windows when the periodic cleanup runs', async () => {
    const db = await freshDb();
    await rateLimit(db, 'voteByIp', 'old', { now: 0 });
    const now = 3 * 3600000;
    await rateLimit(db, 'voteByIp', 'new', { now });
    await sweepExpiredStorms(db, now);
    const rows = (await db.execute('SELECT window_start FROM rate_limits')).rows;
    expect(rows.map((r) => Number(r.window_start))).toEqual([Math.floor(now / MINUTE) * MINUTE]);
  });

  it('finds the caller address from the headers Netlify sets', () => {
    expect(clientIp({ headers: { 'x-nf-client-connection-ip': '1.1.1.1', 'client-ip': '2.2.2.2' } })).toBe('1.1.1.1');
    expect(clientIp({ headers: { 'client-ip': '2.2.2.2' } })).toBe('2.2.2.2');
    expect(clientIp({ headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' } })).toBe('3.3.3.3');
    expect(clientIp({ headers: {} })).toBeNull();
    expect(clientIp({})).toBeNull();
  });
});
