import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
  createPairTokenRequest: vi.fn(async (id) => ({ keyName: 'fake', capability: `{"pair:${id}":["publish","subscribe"]}` })),
}));

import { createPairTokenRequest } from '../../lib/realtime.js';
import { createDb, initSchema } from '../../lib/db.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';
import { handler } from '../../netlify/functions/pair-token.js';

const ID = 'ab12'.repeat(16);
const IP_A = { 'x-nf-client-connection-ip': '198.51.100.7' };
const IP_B = { 'x-nf-client-connection-ip': '198.51.100.8' };

describe('pair-token function', () => {
  let db;
  let issuer;
  let restore;
  let tokenA;
  let tokenB;

  beforeAll(async () => {
    issuer = await makeIssuer();
  });

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    restore = useIssuer(issuer);
    db = createDb();
    await initSchema(db);
    createPairTokenRequest.mockClear();
    tokenA = await issuer.sign({ name: 'Alice' }, { sub: 'alice' });
    tokenB = await issuer.sign({ name: 'Bob' }, { sub: 'bob' });
  });
  afterEach(() => {
    restore();
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.RATE_LIMIT_SCALE;
  });

  const get = (query, jwt = tokenA, ip = IP_A) => handler({ httpMethod: 'GET', queryStringParameters: query, headers: { ...ip, ...(jwt ? bearer(jwt) : {}) } });
  const rowCounts = async () => {
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const out = {};
    for (const { name } of tables.rows) out[name] = Number((await db.execute(`SELECT COUNT(*) AS n FROM ${name}`)).rows[0].n);
    return out;
  };

  it('returns a token request for exactly the one channel, to a licensed caller', async () => {
    const res = await get({ id: ID });
    expect(res.statusCode).toBe(200);
    expect(createPairTokenRequest).toHaveBeenCalledWith(ID);
    expect(Object.keys(JSON.parse(JSON.parse(res.body).capability))).toEqual([`pair:${ID}`]);
  });

  it('refuses the anonymous tier with 403 license_required, writing nothing at all', async () => {
    const res = await get({ id: ID }, null);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('license_required');
    expect(createPairTokenRequest).not.toHaveBeenCalled();
    expect(Object.values(await rowCounts()).every((n) => n === 0)).toBe(true);
  });

  it('refuses a licensed token whose subject is the anonymous id', async () => {
    const impostor = await issuer.sign({ name: 'Impostor' }, { sub: 'anonymous' });
    expect((await get({ id: ID }, impostor)).statusCode).toBe(403);
    expect(createPairTokenRequest).not.toHaveBeenCalled();
  });

  it('answers a bad license with 401 license_invalid', async () => {
    const res = await get({ id: ID }, 'not-a-jwt');
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe('license_invalid');
    expect(createPairTokenRequest).not.toHaveBeenCalled();
    expect(Object.values(await rowCounts()).every((n) => n === 0)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['too short', 'ab12'],
    ['uppercase', ID.toUpperCase()],
    ['not hex', 'z'.repeat(64)],
    ['too long', ID + 'a'],
    ['a channel wildcard', '*'],
    ['a storm channel name', 'storm:ABCD1234'],
  ])('answers 400 for an id that is %s and never asks Ably for a token', async (_label, id) => {
    const res = await get({ id });
    expect(res.statusCode).toBe(400);
    expect(createPairTokenRequest).not.toHaveBeenCalled();
  });

  it('only answers GET', async () => {
    const res = await handler({ httpMethod: 'POST', queryStringParameters: { id: ID }, headers: bearer(tokenA) });
    expect(res.statusCode).toBe(405);
  });

  it('rate limits per license, 10 per hour: one license shares a count across addresses, another license has its own', async () => {
    process.env.RATE_LIMIT_SCALE = '0.3'; // 10 per hour becomes 3
    expect((await get({ id: ID }, tokenA, IP_A)).statusCode).toBe(200);
    expect((await get({ id: ID }, tokenA, IP_B)).statusCode).toBe(200);
    expect((await get({ id: ID }, tokenA, {})).statusCode).toBe(200);
    const blocked = await get({ id: ID }, tokenA, IP_B);
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body).code).toBe('rate_limited');
    // Whole seconds until the window ends, which the dialog turns into when to try again.
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get({ id: ID }, tokenB, IP_A)).statusCode).toBe(200);
  });

  it('keeps nothing but the rate-limit counter', async () => {
    await get({ id: ID });
    const counts = await rowCounts();
    for (const [name, n] of Object.entries(counts)) expect(n, name).toBe(name === 'rate_limits' ? 1 : 0);
  });
});
