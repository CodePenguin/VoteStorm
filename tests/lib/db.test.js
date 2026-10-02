import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb,
  initSchema,
  getRoomByCode,
  getRoomByAdminKeyHash,
  todayDateString,
  touchRoomActivity,
  deleteRoomCascade,
  sweepExpiredRooms,
} from '../../lib/db.js';

function tempDbUrl() {
  const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
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

  it('touchRoomActivity sets last_activity_date to today', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: ['hash123', 'ROOM01', Date.now()],
    });
    await touchRoomActivity(db, 'ROOM01');
    const room = await getRoomByCode(db, 'ROOM01');
    expect(room.last_activity_date).toBe(todayDateString());
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

  it('sweepExpiredRooms deletes rooms inactive past the cutoff and leaves recent rooms alone', async () => {
    const db = createDb(tempDbUrl());
    await initSchema(db);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 15);
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_date) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['old-hash', 'OLDROOM', Date.now(), oldDateStr],
    });
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_date) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['new-hash', 'NEWROOM', Date.now(), todayDateString()],
    });

    const deletedCount = await sweepExpiredRooms(db, 14);

    expect(deletedCount).toBe(1);
    expect(await getRoomByCode(db, 'OLDROOM')).toBeNull();
    expect(await getRoomByCode(db, 'NEWROOM')).not.toBeNull();
  });

  it('existing database files without last_activity_date get the column added by initSchema', async () => {
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
    expect(room.last_activity_date).toBe(todayDateString());
  });
});
