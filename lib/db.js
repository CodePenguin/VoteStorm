import { createClient } from '@libsql/client';
import { DEFAULT_INACTIVITY_HOURS } from './license.js';

export function getDbUrl() {
  if (process.env.TURSO_DATABASE_URL) {
    return process.env.TURSO_DATABASE_URL;
  }
  return 'file:./data/local-dev.db';
}

// Clients are created per request, so remember which database each one points at; the schema only needs
// setting up once per database per server instance, not on every request.
const clientUrls = new WeakMap();
const schemaReady = new Map();

export function createDb(url = getDbUrl()) {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { url, authToken } : { url });
  clientUrls.set(client, url);
  return client;
}

export async function initSchema(db) {
  const url = clientUrls.get(db);
  if (!url) return runSchema(db);
  let ready = schemaReady.get(url);
  if (!ready) {
    ready = runSchema(db);
    schemaReady.set(url, ready);
    ready.catch(() => schemaReady.delete(url));
  }
  return ready;
}

async function runSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
    admin_key_hash TEXT PRIMARY KEY,
    room_code TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'lobby',
    current_question_id INTEGER,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    inactivity_hours INTEGER,
    license_id TEXT,
    license_json TEXT
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
  for (const col of ['last_activity_at INTEGER', 'inactivity_hours INTEGER', 'license_id TEXT', 'license_json TEXT']) {
    try {
      await db.execute(`ALTER TABLE rooms ADD COLUMN ${col}`);
    } catch {
      // column already exists
    }
  }
  try {
    await db.execute('ALTER TABLE questions ADD COLUMN multi INTEGER NOT NULL DEFAULT 0');
  } catch {
    // column already exists
  }
  for (const col of ['results_hidden INTEGER NOT NULL DEFAULT 0', 'answer_shown INTEGER NOT NULL DEFAULT 0', 'correct TEXT', 'display TEXT']) {
    try {
      await db.execute(`ALTER TABLE questions ADD COLUMN ${col}`);
    } catch {
      // column already exists
    }
  }
  try {
    await db.execute('ALTER TABLE rooms ADD COLUMN results_key_hash TEXT');
  } catch {
    // column already exists
  }
  try {
    await db.execute('ALTER TABLE rooms ADD COLUMN show_connect INTEGER');
  } catch {
    // column already exists
  }
  // Databases from before exact activity times: carry the old day-stamp over, else fall back to creation time.
  try {
    await db.execute("UPDATE rooms SET last_activity_at = CAST(strftime('%s', last_activity_date) AS INTEGER) * 1000 WHERE last_activity_at IS NULL AND last_activity_date IS NOT NULL");
  } catch {
    // no legacy last_activity_date column
  }
  await db.execute('UPDATE rooms SET last_activity_at = created_at WHERE last_activity_at IS NULL');
  await db.execute({ sql: 'UPDATE rooms SET inactivity_hours = ? WHERE inactivity_hours IS NULL', args: [DEFAULT_INACTIVITY_HOURS] });
}

// show_connect is NULL until the presenter overrides it; then it follows the room:
// the join screen shows while nobody has a question up and the room is not closed.
export function connectVisible(room, status = room.status, currentQuestionId = room.current_question_id) {
  if (room.show_connect !== null && room.show_connect !== undefined) return Number(room.show_connect) === 1;
  return !currentQuestionId && status !== 'closed';
}

export async function touchRoomActivity(db, roomCode) {
  await db.execute({
    sql: 'UPDATE rooms SET last_activity_at = ? WHERE room_code = ?',
    args: [Date.now(), roomCode],
  });
}

/** A room expires after its own inactivity window (set by the license it was created under). */
export function isRoomExpired(room, now = Date.now()) {
  const last = Number(room.last_activity_at ?? room.created_at);
  const hours = Number(room.inactivity_hours ?? DEFAULT_INACTIVITY_HOURS);
  return now - last > hours * 3600000;
}

export async function deleteRoomCascade(db, roomCode) {
  const questionsResult = await db.execute({ sql: 'SELECT id FROM questions WHERE room_code = ?', args: [roomCode] });
  for (const q of questionsResult.rows) {
    await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [q.id] });
  }
  await db.execute({ sql: 'DELETE FROM questions WHERE room_code = ?', args: [roomCode] });
  await db.execute({ sql: 'DELETE FROM rooms WHERE room_code = ?', args: [roomCode] });
}

export async function sweepExpiredRooms(db, now = Date.now()) {
  const expiredResult = await db.execute({
    sql: 'SELECT room_code FROM rooms WHERE COALESCE(last_activity_at, created_at) + COALESCE(inactivity_hours, ?) * 3600000 < ?',
    args: [DEFAULT_INACTIVITY_HOURS, now],
  });
  for (const row of expiredResult.rows) {
    await deleteRoomCascade(db, row.room_code);
  }
  return expiredResult.rows.length;
}

// Looked-up rooms that have outlived their inactivity window are removed on contact, so expiry does not
// depend on the periodic sweep having run.
async function liveRoom(db, room) {
  if (room && isRoomExpired(room)) {
    await deleteRoomCascade(db, room.room_code);
    return null;
  }
  return room || null;
}

export async function getRoomByCode(db, roomCode) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE room_code = ?', args: [roomCode] });
  return liveRoom(db, result.rows[0]);
}

export async function getRoomByAdminKeyHash(db, adminKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE admin_key_hash = ?', args: [adminKeyHash] });
  return liveRoom(db, result.rows[0]);
}

export async function getRoomByResultsKeyHash(db, resultsKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM rooms WHERE results_key_hash = ?', args: [resultsKeyHash] });
  return liveRoom(db, result.rows[0]);
}
