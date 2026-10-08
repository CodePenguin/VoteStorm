import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handler } from '../../netlify/functions/create-storm.js';
import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { makeAdmin, seedStorm } from '../helpers/admin.js';

describe('create-storm function', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  const create = (body) => handler({ httpMethod: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const credentialsOf = (admin) => ({ publicKey: admin.publicKey, resultsKeyHash: admin.resultsKeyHash });

  it('creates a storm and returns an 8-character stormCode and no adminKey', async () => {
    const res = await create(credentialsOf(await makeAdmin()));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.stormCode).toHaveLength(8);
    expect(body).not.toHaveProperty('adminKey');
  });

  it('stores the public key and the results key hash it was sent', async () => {
    const admin = await makeAdmin();
    const { stormCode } = JSON.parse((await create(credentialsOf(admin))).body);
    const storm = await getStormByCode(createDb(), stormCode);
    expect(storm.admin_public_key).toBe(admin.publicKey);
    expect(storm.results_key_hash).toBe(admin.resultsKeyHash);
  });

  it('rejects non-POST methods', async () => {
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(405);
  });

  it('refuses a bad public key', async () => {
    const admin = await makeAdmin();
    const tooShort = admin.publicKey.slice(0, -4);
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    expect((await create({ ...credentialsOf(admin), publicKey: tooShort })).statusCode).toBe(400);
    expect((await create({ ...credentialsOf(admin), publicKey: offCurve })).statusCode).toBe(400);
    expect((await create({ ...credentialsOf(admin), publicKey: 42 })).statusCode).toBe(400);
  });

  it('refuses a bad results key hash', async () => {
    const admin = await makeAdmin();
    expect((await create({ ...credentialsOf(admin), resultsKeyHash: 'abc' })).statusCode).toBe(400);
    expect((await create({ publicKey: admin.publicKey })).statusCode).toBe(400);
  });

  it('refuses a request with no body or a malformed one', async () => {
    expect((await create(undefined)).statusCode).toBe(400);
    expect((await handler({ httpMethod: 'POST', body: '{' })).statusCode).toBe(400);
  });

  it('refuses a public key that already belongs to a Storm', async () => {
    const credentials = credentialsOf(await makeAdmin());
    expect((await create(credentials)).statusCode).toBe(200);
    expect((await create(credentials)).statusCode).toBe(409);
  });

  it('sets last_activity_at to now and the default 24-hour window on the new storm', async () => {
    const res = await create(credentialsOf(await makeAdmin()));
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
    const stale = await seedStorm(db, { last_activity_at: Date.now() - 25 * 3600000 });

    await create(credentialsOf(await makeAdmin()));

    const gone = await db.execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stale.stormCode] });
    expect(gone.rows).toHaveLength(0);
  });

  it('does not sweep storms active within the last 24 hours', async () => {
    const db = createDb();
    await initSchema(db);
    const fresh = await seedStorm(db, { last_activity_at: Date.now() - 3600000 });

    await create(credentialsOf(await makeAdmin()));

    expect(await getStormByCode(db, fresh.stormCode)).not.toBeNull();
  });
});
