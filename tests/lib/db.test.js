import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema, getRoomByCode, getRoomByAdminKeyHash } from '../../lib/db.js';

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
});
