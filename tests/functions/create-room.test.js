import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handler } from '../../netlify/functions/create-room.js';
import { createDb, initSchema, getRoomByCode, todayDateString } from '../../lib/db.js';

describe('create-room function', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('creates a room and returns adminKey + roomCode', async () => {
    const res = await handler({ httpMethod: 'POST' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.adminKey).toMatch(/^[0-9a-f]{48}$/);
    expect(body.roomCode).toHaveLength(6);
  });

  it('rejects non-POST methods', async () => {
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(405);
  });

  it('sets last_activity_date to today on the new room', async () => {
    const res = await handler({ httpMethod: 'POST' });
    const { roomCode } = JSON.parse(res.body);

    const db = createDb();
    const room = await getRoomByCode(db, roomCode);
    expect(room.last_activity_date).toBe(todayDateString());
  });

  it('sweeps rooms inactive for more than 14 days when a new room is created', async () => {
    const db = createDb();
    await initSchema(db);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_date) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['stale-hash', 'STALE1', Date.now(), oldDateStr],
    });

    await handler({ httpMethod: 'POST' });

    expect(await getRoomByCode(db, 'STALE1')).toBeNull();
  });

  it('does not sweep rooms active within the last 14 days', async () => {
    const db = createDb();
    await initSchema(db);

    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at, last_activity_date) VALUES (?, ?, 'lobby', ?, ?)`,
      args: ['fresh-hash', 'FRESH1', Date.now(), todayDateString()],
    });

    await handler({ httpMethod: 'POST' });

    expect(await getRoomByCode(db, 'FRESH1')).not.toBeNull();
  });
});
