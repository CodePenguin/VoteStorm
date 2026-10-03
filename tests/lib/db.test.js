import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb,
  initSchema,
  getRoomByCode,
  getRoomByAdminKeyHash,
  touchRoomActivity,
  deleteRoomCascade,
  sweepExpiredRooms,
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
    expect(tables.rows.map((r) => r.name)).toEqual(['questions', 'rooms', 'votes']);
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

  it('getRoomByCode and getRoomByAdminKeyHash find an inserted room', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'ROOM01', Date.now()],
    });
    expect((await getRoomByCode(db, 'ROOM01')).room_code).toBe('ROOM01');
    expect((await getRoomByAdminKeyHash(db, 'hash123')).room_code).toBe('ROOM01');
    expect(await getRoomByCode(db, 'NOPE00')).toBeNull();
  });

  it('touchRoomActivity sets last_activity_at to now', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'ROOM01', Date.now()],
    });
    await touchRoomActivity(db, 'ROOM01');
    const room = await getRoomByCode(db, 'ROOM01');
    expect(Number(room.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('deleteRoomCascade removes the room and its questions/votes', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'ROOM01', Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (1, 'ROOM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)',
      args: ['dev-1', '0', Date.now()],
    });

    await deleteRoomCascade(db, 'ROOM01');

    expect(await getRoomByCode(db, 'ROOM01')).toBeNull();
    const questions = await db.execute({ sql: 'SELECT * FROM questions WHERE room_code = ?', args: ['ROOM01'] });
    expect(questions.rows).toHaveLength(0);
    const votes = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [1] });
    expect(votes.rows).toHaveLength(0);
  });

  it('sweepExpiredRooms removes rooms past their own inactivity window and leaves the rest alone', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    const hour = 3600000;
    const add = (hash, code, ageHours, windowHours) => db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_at, inactivity_hours) VALUES (?, ?, 'lobby', ?, ?, ?)`,
      args: [hash, code, Date.now() - 100 * hour, Date.now() - ageHours * hour, windowHours],
    });
    await add('h1', 'OLD24', 25, 24);
    await add('h2', 'NEW24', 23, 24);
    await add('h3', 'LONGWIN', 100, 168);
    await add('h4', 'SHORT1', 3, 2);

    expect(await sweepExpiredRooms(db)).toBe(2);
    expect(await getRoomByCode(db, 'OLD24')).toBeNull();
    expect(await getRoomByCode(db, 'SHORT1')).toBeNull();
    expect(await getRoomByCode(db, 'NEW24')).not.toBeNull();
    expect(await getRoomByCode(db, 'LONGWIN')).not.toBeNull();
  });

  it('removes an expired room as soon as it is looked up, without waiting for a sweep', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_at, inactivity_hours) VALUES (?, ?, 'lobby', ?, ?, 24)`,
      args: ['hx', 'EXPIRD', Date.now(), Date.now() - 30 * 3600000],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (9, 'EXPIRD', 0, 'choice', 'Q', '["a","b"]', ?)`,
      args: [Date.now()],
    });
    expect(await getRoomByAdminKeyHash(db, 'hx')).toBeNull();
    const leftovers = await db.execute({ sql: 'SELECT * FROM questions WHERE room_code = ?', args: ['EXPIRD'] });
    expect(leftovers.rows).toHaveLength(0);
  });

  it('existing database files without last_activity_at get the column added and backfilled by initSchema', async () => {
    const dbUrl = tempDbUrl();
    const db = createDb(dbUrl);
    // Simulate a pre-existing database created before this column existed.
    await db.execute(`CREATE TABLE rooms (
      admin_key_hash TEXT PRIMARY KEY,
      room_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'lobby',
      current_question_id INTEGER,
      created_at INTEGER NOT NULL
    )`);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'ROOM01', Date.now()],
    });

    await initSchema(db);
    await touchRoomActivity(db, 'ROOM01');
    const room = await getRoomByCode(db, 'ROOM01');
    expect(Number(room.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });
});
