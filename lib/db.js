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
    created_at INTEGER NOT NULL,
    last_activity_date TEXT
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
  try {
    await db.execute('ALTER TABLE rooms ADD COLUMN last_activity_date TEXT');
  } catch {
    // column already exists on a database created before this field was added
  }
}

export function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export async function touchRoomActivity(db, roomCode) {
  await db.execute({
    sql: 'UPDATE rooms SET last_activity_date = ? WHERE room_code = ?',
    args: [todayDateString(), roomCode],
  });
}

export async function deleteRoomCascade(db, roomCode) {
  const questionsResult = await db.execute({ sql: 'SELECT id FROM questions WHERE room_code = ?', args: [roomCode] });
  for (const q of questionsResult.rows) {
    await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [q.id] });
  }
  await db.execute({ sql: 'DELETE FROM questions WHERE room_code = ?', args: [roomCode] });
  await db.execute({ sql: 'DELETE FROM rooms WHERE room_code = ?', args: [roomCode] });
}

export async function sweepExpiredRooms(db, maxAgeDays = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const expiredResult = await db.execute({
    sql: 'SELECT room_code FROM rooms WHERE last_activity_date < ?',
    args: [cutoffStr],
  });
  for (const row of expiredResult.rows) {
    await deleteRoomCascade(db, row.room_code);
  }
  return expiredResult.rows.length;
}

export async function getRoomByCode(db, roomCode) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE room_code = ?', args: [roomCode] });
  return result.rows[0] || null;
}

export async function getRoomByAdminKeyHash(db, adminKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE admin_key_hash = ?', args: [adminKeyHash] });
  return result.rows[0] || null;
}
