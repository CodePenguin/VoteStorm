import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, initSchema } from '../../lib/db.js';
import { makeAdmin } from '../helpers/admin.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';
import { handler as createStorm } from '../../netlify/functions/create-storm.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { handler as adminClouds } from '../../netlify/functions/admin-clouds.js';
import { handler } from '../../netlify/functions/license-storms.js';

describe('license-storms function', () => {
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
    await initSchema(createDb());
    tokenA = await issuer.sign({ name: 'Alice' }, { sub: 'alice' });
    tokenB = await issuer.sign({ name: 'Bob' }, { sub: 'bob' });
  });

  afterEach(() => {
    restore();
    delete process.env.TURSO_DATABASE_URL;
  });

  const make = async (jwt) => {
    const admin = await makeAdmin();
    const res = await createStorm({
      httpMethod: 'POST', headers: jwt ? bearer(jwt) : {},
      body: JSON.stringify({ publicKey: admin.publicKey, resultsKeyHash: admin.resultsKeyHash }),
    });
    admin.stormCode = JSON.parse(res.body).stormCode;
    return admin;
  };
  const list = (jwt) => handler({ httpMethod: 'GET', headers: jwt ? bearer(jwt) : {} });
  const reclaim = (jwt, body) => handler({ httpMethod: 'POST', headers: jwt ? bearer(jwt) : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const remove = (jwt, body) => handler({ httpMethod: 'DELETE', headers: jwt ? bearer(jwt) : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const row = async (stormCode) => (await createDb().execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stormCode] })).rows[0];
  const signedGet = (admin) => admin.call(adminStorm, 'admin-storm', { httpMethod: 'GET' });
  const fresh = async () => {
    const admin = await makeAdmin();
    return { publicKey: admin.publicKey, resultsKeyHash: admin.resultsKeyHash, admin };
  };

  describe('who may use it', () => {
    it('refuses the anonymous tier on every method, and only answers GET, POST and DELETE', async () => {
      const mine = await make();
      for (const call of [list(), reclaim(undefined, { stormCode: mine.stormCode, ...(await fresh()) }), remove(undefined, { stormCode: mine.stormCode })]) {
        const res = await call;
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).code).toBe('license_required');
      }
      expect((await handler({ httpMethod: 'PATCH', headers: bearer(tokenA) })).statusCode).toBe(405);
      expect(await row(mine.stormCode)).toBeDefined();
    });

    it('refuses a licensed token whose subject is the anonymous id', async () => {
      const impostor = await issuer.sign({ name: 'Impostor' }, { sub: 'anonymous' });
      const mine = await make();
      expect((await list(impostor)).statusCode).toBe(403);
      expect((await remove(impostor, { stormCode: mine.stormCode })).statusCode).toBe(403);
      expect(await row(mine.stormCode)).toBeDefined();
    });

    it('answers a bad license with 401 license_invalid', async () => {
      const res = await list('not-a-jwt');
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).code).toBe('license_invalid');
    });
  });

  describe('listing', () => {
    it('lists only the Storms created under this license, with no key material', async () => {
      const a1 = await make(tokenA);
      const a2 = await make(tokenA);
      const b1 = await make(tokenB);
      await make();
      const res = await list(tokenA);
      expect(res.statusCode).toBe(200);
      const { storms } = JSON.parse(res.body);
      expect(storms.map((s) => s.stormCode).sort()).toEqual([a1.stormCode, a2.stormCode].sort());
      expect(storms.map((s) => s.stormCode)).not.toContain(b1.stormCode);
      expect(Object.keys(storms[0]).sort()).toEqual(['cloudCount', 'expiresAt', 'lastActivityAt', 'name', 'status', 'stormCode']);
    });

    it('reports clouds, activity and expiry, newest activity first', async () => {
      const older = await make(tokenA);
      const newer = await make(tokenA);
      const db = createDb();
      await db.execute({ sql: 'UPDATE storms SET last_activity_at = ?, inactivity_hours = 10 WHERE storm_code = ?', args: [Date.now() - 3600000, older.stormCode] });
      await db.execute({ sql: 'UPDATE storms SET last_activity_at = ?, name = ? WHERE storm_code = ?', args: [Date.now() - 1000, 'Newer', newer.stormCode] });
      await admin2Cloud(newer);
      const { storms } = JSON.parse((await list(tokenA)).body);
      expect(storms.map((s) => s.stormCode)).toEqual([newer.stormCode, older.stormCode]);
      expect(storms[0]).toMatchObject({ name: 'Newer', cloudCount: 1 });
      const olderRow = storms[1];
      expect(olderRow.expiresAt).toBe(olderRow.lastActivityAt + 10 * 3600000);
    });

    async function admin2Cloud(admin) {
      await admin.call(adminClouds, 'admin-clouds', { httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Q', options: ['A', 'B'] }) });
    }
  });

  describe('reclaiming', () => {
    it('gives the Storm a new key: the new one signs, the old one no longer does, and the results key changes', async () => {
      const old = await make(tokenA);
      const next = await fresh();
      const res = await reclaim(tokenA, { stormCode: old.stormCode, publicKey: next.publicKey, resultsKeyHash: next.resultsKeyHash });
      expect(res.statusCode).toBe(200);
      next.admin.stormCode = old.stormCode;
      expect((await signedGet(next.admin)).statusCode).toBe(200);
      expect((await signedGet(old)).statusCode).toBe(401);
      expect((await row(old.stormCode)).results_key_hash).toBe(next.resultsKeyHash);
    });

    it('accepts a lower-case, hyphenated Storm code like every other function', async () => {
      const old = await make(tokenA);
      const next = await fresh();
      const loose = `${old.stormCode.slice(0, 4)}-${old.stormCode.slice(4)}`.toLowerCase();
      expect((await reclaim(tokenA, { stormCode: loose, publicKey: next.publicKey, resultsKeyHash: next.resultsKeyHash })).statusCode).toBe(200);
    });

    it('answers 404 for another license\'s Storm and leaves it untouched', async () => {
      const bobs = await make(tokenB);
      const next = await fresh();
      const res = await reclaim(tokenA, { stormCode: bobs.stormCode, publicKey: next.publicKey, resultsKeyHash: next.resultsKeyHash });
      expect(res.statusCode).toBe(404);
      expect((await signedGet(bobs)).statusCode).toBe(200);
      const missing = await reclaim(tokenA, { stormCode: 'NOPE0000', publicKey: next.publicKey, resultsKeyHash: next.resultsKeyHash });
      expect(missing.statusCode).toBe(404);
    });

    it('answers 409 for a key that already belongs to another Storm, and keeps the old key working', async () => {
      const mine = await make(tokenA);
      const other = await make(tokenA);
      const res = await reclaim(tokenA, { stormCode: mine.stormCode, publicKey: other.publicKey, resultsKeyHash: (await fresh()).resultsKeyHash });
      expect(res.statusCode).toBe(409);
      expect((await signedGet(mine)).statusCode).toBe(200);
    });

    it('answers 400 for a missing or malformed key and bad JSON, 404 for a Storm code that is not text, and 413 for a huge body', async () => {
      const mine = await make(tokenA);
      const next = await fresh();
      expect((await reclaim(tokenA, { stormCode: mine.stormCode })).statusCode).toBe(400);
      expect((await reclaim(tokenA, { stormCode: mine.stormCode, publicKey: 'AAAA', resultsKeyHash: next.resultsKeyHash })).statusCode).toBe(400);
      expect((await reclaim(tokenA, { stormCode: mine.stormCode, publicKey: next.publicKey, resultsKeyHash: 'zz' })).statusCode).toBe(400);
      expect((await reclaim(tokenA, { stormCode: { x: 1 }, publicKey: next.publicKey, resultsKeyHash: next.resultsKeyHash })).statusCode).toBe(404);
      expect((await reclaim(tokenA, '{not json')).statusCode).toBe(400);
      expect((await reclaim(tokenA, 'x'.repeat(5000))).statusCode).toBe(413);
      expect((await signedGet(mine)).statusCode).toBe(200);
    });
  });

  describe('deleting', () => {
    it('deletes the Storm with its clouds and votes, and frees the active-Storm allowance', async () => {
      const capped = await issuer.sign({ name: 'Carol', maxActiveStorms: 1 }, { sub: 'carol' });
      const mine = await make(capped);
      await admin2(mine);
      const db = createDb();
      const cloudId = Number((await db.execute({ sql: 'SELECT id FROM clouds WHERE storm_code = ?', args: [mine.stormCode] })).rows[0].id);
      await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [cloudId, 'device-1', 'A', Date.now()] });
      const full = await createStorm({ httpMethod: 'POST', headers: bearer(capped), body: JSON.stringify({ publicKey: (await fresh()).publicKey, resultsKeyHash: (await fresh()).resultsKeyHash }) });
      expect(full.statusCode).toBe(403);
      expect((await remove(capped, { stormCode: mine.stormCode })).statusCode).toBe(200);
      expect(await row(mine.stormCode)).toBeUndefined();
      expect(Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM votes WHERE cloud_id = ?', args: [cloudId] })).rows[0].n)).toBe(0);
      expect(Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM clouds WHERE storm_code = ?', args: [mine.stormCode] })).rows[0].n)).toBe(0);
      const again = await make(capped);
      expect(again.stormCode).toBeTruthy();
    });

    it('answers 404 for another license\'s Storm and leaves it alone, and 400 for a body it cannot read', async () => {
      const bobs = await make(tokenB);
      expect((await remove(tokenA, { stormCode: bobs.stormCode })).statusCode).toBe(404);
      expect(await row(bobs.stormCode)).toBeDefined();
      expect((await remove(tokenA, { stormCode: 42 })).statusCode).toBe(404);
      expect((await remove(tokenA, '{not json')).statusCode).toBe(400);
    });

    async function admin2(admin) {
      await admin.call(adminClouds, 'admin-clouds', { httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Q', options: ['A', 'B'] }) });
    }
  });
});
