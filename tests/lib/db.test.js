import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb,
  initSchema,
  getStormByCode,
  isStormExpired,
  touchStormActivity,
  deleteStormCascade,
  sweepExpiredStorms,
} from '../../lib/db.js';

function tempDbUrl() {
  const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
  return `file:${path.join(dir, 'test.db')}`;
}

describe('db', () => {
  it('creates all tables on a fresh local sqlite file', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(tables.rows.map((r) => r.name)).toEqual(['clouds', 'rate_limits', 'storms', 'votes']);
  });

  it('gives clouds the word-cloud columns', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const columns = (await db.execute('PRAGMA table_info(clouds)')).rows.map((r) => r.name);
    expect(columns).toEqual(expect.arrayContaining(['max_words', 'hidden_words']));
  });

  it('enforces one vote per device per cloud', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [1, 'device-a', '0', Date.now()],
    });
    await expect(
      db.execute({
        sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
        args: [1, 'device-a', '1', Date.now()],
      })
    ).rejects.toThrow();
  });

  it('getStormByCode finds an inserted storm', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES (?, 'pk', ?, 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    expect((await getStormByCode(db, 'STORM01')).storm_code).toBe('STORM01');
    expect(await getStormByCode(db, 'NOPE00')).toBeNull();
  });

  it('touchStormActivity sets last_activity_at to now', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES (?, 'pk', ?, 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    await touchStormActivity(db, 'STORM01');
    const storm = await getStormByCode(db, 'STORM01');
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('deleteStormCascade removes the storm and its clouds/votes', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES (?, 'pk', ?, 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (1, 'STORM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (1, ?, ?, ?)',
      args: ['dev-1', '0', Date.now()],
    });

    await deleteStormCascade(db, 'STORM01');

    expect(await getStormByCode(db, 'STORM01')).toBeNull();
    const clouds = await db.execute({ sql: 'SELECT * FROM clouds WHERE storm_code = ?', args: ['STORM01'] });
    expect(clouds.rows).toHaveLength(0);
    const votes = await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [1] });
    expect(votes.rows).toHaveLength(0);
  });

  it('sweepExpiredStorms removes storms past their own inactivity window and leaves the rest alone', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const hour = 3600000;
    const add = (hash, code, ageHours, windowHours) => db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, last_activity_at, inactivity_hours, license_json) VALUES (?, 'pk', ?, 'lobby', ?, ?, ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: [hash, code, Date.now() - 100 * hour, Date.now() - ageHours * hour, windowHours],
    });
    await add('h1', 'OLD24', 25, 24);
    await add('h2', 'NEW24', 23, 24);
    await add('h3', 'LONGWIN', 100, 168);
    await add('h4', 'SHORT1', 3, 2);

    expect(await sweepExpiredStorms(db)).toBe(2);
    expect(await getStormByCode(db, 'OLD24')).toBeNull();
    expect(await getStormByCode(db, 'SHORT1')).toBeNull();
    expect(await getStormByCode(db, 'NEW24')).not.toBeNull();
    expect(await getStormByCode(db, 'LONGWIN')).not.toBeNull();
  });

  it('removes an expired storm as soon as it is looked up, without waiting for a sweep', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, last_activity_at, inactivity_hours, license_json) VALUES (?, 'pk', ?, 'lobby', ?, ?, 24, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['hx', 'EXPIRD', Date.now(), Date.now() - 30 * 3600000],
    });
    await db.execute({
      sql: `INSERT INTO clouds (id, storm_code, order_index, kind, body, options, created_at) VALUES (9, 'EXPIRD', 0, 'choice', 'Q', '["a","b"]', ?)`,
      args: [Date.now()],
    });
    expect(await getStormByCode(db, 'EXPIRD')).toBeNull();
    const leftovers = await db.execute({ sql: 'SELECT * FROM clouds WHERE storm_code = ?', args: ['EXPIRD'] });
    expect(leftovers.rows).toHaveLength(0);
  });

  it('existing database files without last_activity_at get the column added and backfilled by initSchema', async () => {
    const dbUrl = tempDbUrl();
    const db = createDb(dbUrl);
    // Simulate a pre-existing database created before this column existed.
    await db.execute(`CREATE TABLE storms (
      admin_key_hash TEXT PRIMARY KEY,
      storm_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'lobby',
      current_cloud_id INTEGER,
      created_at INTEGER NOT NULL,
      license_json TEXT
    )`);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_json) VALUES (?, ?, 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['hash123', 'STORM01', Date.now()],
    });

    await initSchema(db);
    await db.execute("UPDATE storms SET admin_public_key = 'pk'");
    await touchStormActivity(db, 'STORM01');
    const storm = await getStormByCode(db, 'STORM01');
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('sets the schema up once per database, not on every request', async () => {
    const url = tempDbUrl();
    const first = createDb(url);
    await initSchema(first);

    const second = createDb(url);
    const execute = vi.spyOn(second, 'execute');
    await initSchema(second);
    await initSchema(createDb(url));
    expect(execute).not.toHaveBeenCalled();
    // and the tables really are there for later requests
    await second.execute({ sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES (?, 'pk', ?, 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`, args: ['h', 'CACHE1', Date.now()] });
    expect((await getStormByCode(second, 'CACHE1')).storm_code).toBe('CACHE1');
  });

  it('does not run the schema twice when requests arrive at the same time', async () => {
    const url = tempDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    const runA = vi.spyOn(a, 'execute');
    const runB = vi.spyOn(b, 'execute');
    await Promise.all([initSchema(a), initSchema(b)]);
    expect(runA.mock.calls.length > 0 && runB.mock.calls.length > 0).toBe(false);
  });

  it('treats a storm with no stored license as expired: removed when looked up, and by the sweep', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const insert = (code) =>
      db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`, args: [`h-${code}`, code, Date.now()] });
    await insert('NOLIC1');
    await insert('NOLIC2');
    expect(await getStormByCode(db, 'NOLIC1')).toBeNull();
    expect((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM storms WHERE storm_code = ?', args: ['NOLIC1'] })).rows[0].n).toBe(0);
    expect(await sweepExpiredStorms(db)).toBe(1);
    expect((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n).toBe(0);
  });

  it('treats a storm with a license but no public key as expired: isStormExpired, lookup and sweep', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const license = '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}';
    const insert = (code, publicKey) =>
      db.execute({
        sql: "INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES (?, ?, ?, 'lobby', ?, ?)",
        args: [`h-${code}`, publicKey, code, Date.now(), license],
      });
    expect(isStormExpired({ license_json: license, admin_public_key: null, created_at: Date.now() })).toBe(true);
    expect(isStormExpired({ license_json: license, admin_public_key: 'pk', created_at: Date.now() })).toBe(false);
    await insert('NOKEY1', null);
    await insert('NOKEY2', null);
    await insert('HASKEY', 'pk');
    expect(await getStormByCode(db, 'NOKEY1')).toBeNull();
    expect((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM storms WHERE storm_code = ?', args: ['NOKEY1'] })).rows[0].n).toBe(0);
    expect(await sweepExpiredStorms(db)).toBe(1);
    expect(await getStormByCode(db, 'HASKEY')).not.toBeNull();
  });

  it('getStormByCode normalises the code it is given', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, license_json) VALUES ('h', 'pk', 'ABCDEFGH', 'lobby', ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: [Date.now()],
    });
    expect((await getStormByCode(db, 'abcd-efgh')).storm_code).toBe('ABCDEFGH');
  });

  it('keeps separate databases separate', async () => {
    const one = createDb(tempDbUrl());
    const two = createDb(tempDbUrl());
    await initSchema(one);
    await initSchema(two);
    await expect(two.execute('SELECT COUNT(*) FROM storms')).resolves.toBeTruthy();
  });

  it('fills in the creator of storms that were made before it was recorded', async () => {
    const url = tempDbUrl();
    const db = createDb(url);
    await db.execute(`CREATE TABLE storms (
      admin_key_hash TEXT PRIMARY KEY,
      storm_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'lobby',
      current_cloud_id INTEGER,
      created_at INTEGER NOT NULL,
      license_id TEXT,
      license_json TEXT
    )`);
    await db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_id, license_json) VALUES ('h1', 'OLDANO', 'lobby', ?, NULL, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`, args: [Date.now()] });
    await db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_id, license_json) VALUES ('h2', 'OLDLIC', 'lobby', ?, 'acme', '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`, args: [Date.now()] });
    await initSchema(createDb(url));
    await db.execute("UPDATE storms SET admin_public_key = 'pk'");
    expect((await getStormByCode(createDb(url), 'OLDANO')).created_by_license_id).toBe('anonymous');
    expect((await getStormByCode(createDb(url), 'OLDLIC')).created_by_license_id).toBe('acme');
  });

  describe('a database from before clouds', () => {
    const OLD_MESSAGE = 'This database is from before clouds: drop the storms, questions and votes tables, then try again.';

    async function makeOldShapedDb(url) {
      const db = createDb(url);
      await db.execute(`CREATE TABLE storms (
        admin_key_hash TEXT PRIMARY KEY,
        admin_public_key TEXT,
        storm_code TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'lobby',
        current_question_id INTEGER,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        inactivity_hours INTEGER,
        license_id TEXT,
        license_json TEXT,
        created_by_license_id TEXT,
        created_by_license_name TEXT
      )`);
      await db.execute(`CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storm_code TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      await db.execute(`CREATE TABLE votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(question_id, device_id)
      )`);
      return db;
    }

    it('refuses to start with a clear message instead of failing later', async () => {
      const url = tempDbUrl();
      await makeOldShapedDb(url);
      await expect(initSchema(createDb(url))).rejects.toThrow(OLD_MESSAGE);
    });

    it('does not remember the refusal: after the old tables are dropped the next call builds the new schema', async () => {
      const url = tempDbUrl();
      const db = await makeOldShapedDb(url);
      await expect(initSchema(createDb(url))).rejects.toThrow(OLD_MESSAGE);
      await db.execute('DROP TABLE votes');
      await db.execute('DROP TABLE questions');
      await db.execute('DROP TABLE storms');
      await db.execute('DROP TABLE IF EXISTS clouds');
      await expect(initSchema(createDb(url))).resolves.toBeUndefined();
      const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      expect(tables.rows.map((r) => r.name)).toEqual(['clouds', 'rate_limits', 'storms', 'votes']);
    });

    it('refuses an old votes table even when storms already has the new column', async () => {
      const url = tempDbUrl();
      const db = createDb(url);
      await db.execute('CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, device_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)');
      await expect(initSchema(createDb(url))).rejects.toThrow(OLD_MESSAGE);
    });

    it('passes on a fresh database, twice', async () => {
      const url = tempDbUrl();
      await expect(initSchema(createDb(url))).resolves.toBeUndefined();
      await expect(initSchema(createDb(url))).resolves.toBeUndefined();
    });
  });
});
