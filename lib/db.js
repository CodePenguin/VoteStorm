import { createClient } from '@libsql/client';

export function getDbUrl() {
  if (process.env.TURSO_DATABASE_URL) {
    return process.env.TURSO_DATABASE_URL;
  }
  return 'file:./data/local-dev.db';
}

export function createDb(url = getDbUrl()) {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  return createClient(authToken ? { url, authToken } : { url });
}

export async function initSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
    admin_key_hash TEXT PRIMARY KEY,
    room_code TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'lobby',
    current_question_id INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options TEXT,
    scale_min INTEGER,
    scale_max INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(question_id, device_id)
  )`);
}

export async function getRoomByCode(db, roomCode) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE room_code = ?', args: [roomCode] });
  return result.rows[0] || null;
}

export async function getRoomByAdminKeyHash(db, adminKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE admin_key_hash = ?', args: [adminKeyHash] });
  return result.rows[0] || null;
}
