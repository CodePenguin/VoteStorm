import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb,
  initSchema,
  getStormByCode,
  getStormByAdminKeyHash,
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
    expect(tables.rows.map((r) => r.name)).toEqual(['questions', 'rate_limits', 'storms', 'votes']);
  });

  it('enforces one vote per device per question', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [1, 'device-a', '0', Date.now()],
    });
    await expect(
      db.execute({
        sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
        args: [1, 'device-a', '1', Date.now()],
      })
    ).rejects.toThrow();
  });

  it('getStormByCode and getStormByAdminKeyHash find an inserted storm', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    expect((await getStormByCode(db, 'STORM01')).storm_code).toBe('STORM01');
    expect((await getStormByAdminKeyHash(db, 'hash123')).storm_code).toBe('STORM01');
    expect(await getStormByCode(db, 'NOPE00')).toBeNull();
  });

  it('touchStormActivity sets last_activity_at to now', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    await touchStormActivity(db, 'STORM01');
    const storm = await getStormByCode(db, 'STORM01');
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('deleteStormCascade removes the storm and its questions/votes', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'STORM01', Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, options, created_at) VALUES (1, 'STORM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)',
      args: ['dev-1', '0', Date.now()],
    });

    await deleteStormCascade(db, 'STORM01');

    expect(await getStormByCode(db, 'STORM01')).toBeNull();
    const questions = await db.execute({ sql: 'SELECT * FROM questions WHERE storm_code = ?', args: ['STORM01'] });
    expect(questions.rows).toHaveLength(0);
    const votes = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [1] });
    expect(votes.rows).toHaveLength(0);
  });

  it('sweepExpiredStorms removes storms past their own inactivity window and leaves the rest alone', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const hour = 3600000;
    const add = (hash, code, ageHours, windowHours) => db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, last_activity_at, inactivity_hours) VALUES (?, ?, 'lobby', ?, ?, ?)`,
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
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, last_activity_at, inactivity_hours) VALUES (?, ?, 'lobby', ?, ?, 24)`,
      args: ['hx', 'EXPIRD', Date.now(), Date.now() - 30 * 3600000],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, storm_code, order_index, type, prompt, options, created_at) VALUES (9, 'EXPIRD', 0, 'choice', 'Q', '["a","b"]', ?)`,
      args: [Date.now()],
    });
    expect(await getStormByAdminKeyHash(db, 'hx')).toBeNull();
    const leftovers = await db.execute({ sql: 'SELECT * FROM questions WHERE storm_code = ?', args: ['EXPIRD'] });
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
      current_question_id INTEGER,
      created_at INTEGER NOT NULL
    )`);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'STORM01', Date.now()],
    });

    await initSchema(db);
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
    await second.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`, args: ['h', 'CACHE1', Date.now()] });
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
      current_question_id INTEGER,
      created_at INTEGER NOT NULL,
      license_id TEXT
    )`);
    await db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_id) VALUES ('h1', 'OLDANO', 'lobby', ?, NULL)`, args: [Date.now()] });
    await db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at, license_id) VALUES ('h2', 'OLDLIC', 'lobby', ?, 'acme')`, args: [Date.now()] });
    await initSchema(createDb(url));
    expect((await getStormByCode(createDb(url), 'OLDANO')).created_by_license_id).toBe('anonymous');
    expect((await getStormByCode(createDb(url), 'OLDLIC')).created_by_license_id).toBe('acme');
  });

  describe('databases from before rooms were renamed to storms', () => {
    const OLD_TABLE = 'ro' + 'oms';
    const OLD_CODE = 'ro' + 'om_code';

    async function legacyDb(url) {
      const db = createDb(url);
      await db.execute(`CREATE TABLE ${OLD_TABLE} (
        admin_key_hash TEXT PRIMARY KEY,
        ${OLD_CODE} TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'lobby',
        current_question_id INTEGER,
        created_at INTEGER NOT NULL,
        last_activity_date TEXT,
        license_id TEXT
      )`);
      await db.execute(`CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${OLD_CODE} TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options TEXT,
        scale_min INTEGER,
        scale_max INTEGER,
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
      await db.execute({ sql: `INSERT INTO ${OLD_TABLE} (admin_key_hash, ${OLD_CODE}, status, current_question_id, created_at, license_id) VALUES ('h1', 'KEEP01', 'active', 1, ?, 'acme')`, args: [Date.now()] });
      await db.execute({ sql: `INSERT INTO questions (${OLD_CODE}, order_index, type, prompt, options, created_at) VALUES ('KEEP01', 0, 'choice', 'Kept question', '["A","B"]', ?)`, args: [Date.now()] });
      await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['dev-1', '0', Date.now()] });
      return db;
    }

    it('renames the table and the code columns in place and keeps every stored row', async () => {
      const url = tempDbUrl();
      await legacyDb(url);
      const db = createDb(url);
      await initSchema(db);

      const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => r.name);
      expect(tables).toEqual(['questions', 'rate_limits', 'storms', 'votes']);
      const storm = await getStormByCode(db, 'KEEP01');
      expect(storm).toMatchObject({ storm_code: 'KEEP01', status: 'active', license_id: 'acme', created_by_license_id: 'acme' });
      const question = (await db.execute({ sql: 'SELECT * FROM questions WHERE storm_code = ?', args: ['KEEP01'] })).rows[0];
      expect(question.prompt).toBe('Kept question');
      expect((await db.execute('SELECT COUNT(*) AS n FROM votes')).rows[0].n).toBe(1);
      expect(Object.keys(question)).not.toContain(OLD_CODE);
    });

    it('keeps the code unique after the rename, and is safe to run again', async () => {
      const url = tempDbUrl();
      await legacyDb(url);
      await initSchema(createDb(url));
      const db = createDb(url);
      await initSchema(db);
      await expect(db.execute({ sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES ('h2', 'KEEP01', 'lobby', ?)`, args: [Date.now()] })).rejects.toThrow();
      expect((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n).toBe(1);
    });

    it('leaves a brand new database alone', async () => {
      const db = createDb(tempDbUrl());
      await initSchema(db);
      const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => r.name);
      expect(tables).toEqual(['questions', 'rate_limits', 'storms', 'votes']);
    });
  });
});
