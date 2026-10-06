import { createClient } from '@libsql/client';
import { DEFAULT_INACTIVITY_HOURS } from './license.js';
import { isHosted } from './runtime.js';

// Deployed functions have no persistent disk, so a local database file would quietly lose every storm.

export function getDbUrl() {
  if (process.env.TURSO_DATABASE_URL) {
    return process.env.TURSO_DATABASE_URL;
  }
  if (isHosted()) {
    throw new Error('TURSO_DATABASE_URL is not set. A hosted deployment needs a remote libSQL database; the local SQLite file is for development only.');
  }
  return 'file:./data/local-dev.db';
}

/** True when a write failed because a unique value already exists. */
export function isUniqueConstraintError(error) {
  if (!error) return false;
  if (typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) return true;
  return typeof error.message === 'string' && /unique constraint/i.test(error.message);
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
  await db.execute(`CREATE TABLE IF NOT EXISTS storms (
    admin_key_hash TEXT PRIMARY KEY,
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
  await db.execute(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storm_code TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options TEXT,
    scale_min INTEGER,
    scale_max INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket, window_start)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(question_id, device_id)
  )`);
  for (const col of ['last_activity_at INTEGER', 'inactivity_hours INTEGER', 'license_id TEXT', 'license_json TEXT', 'created_by_license_id TEXT', 'created_by_license_name TEXT']) {
    try {
      await db.execute(`ALTER TABLE storms ADD COLUMN ${col}`);
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
    await db.execute('ALTER TABLE storms ADD COLUMN results_key_hash TEXT');
  } catch {
    // column already exists
  }
  try {
    await db.execute('ALTER TABLE storms ADD COLUMN show_connect INTEGER');
  } catch {
    // column already exists
  }
  try {
    await db.execute('ALTER TABLE storms ADD COLUMN results_background TEXT');
  } catch {
    // column already exists
  }
  // Databases from before exact activity times: carry the old day-stamp over, else fall back to creation time.
  try {
    await db.execute("UPDATE storms SET last_activity_at = CAST(strftime('%s', last_activity_date) AS INTEGER) * 1000 WHERE last_activity_at IS NULL AND last_activity_date IS NOT NULL");
  } catch {
    // no legacy last_activity_date column
  }
  await db.execute('UPDATE storms SET last_activity_at = created_at WHERE last_activity_at IS NULL');
  // Storms from before the creator was recorded: whoever held a license then, or the anonymous tier.
  await db.execute("UPDATE storms SET created_by_license_id = COALESCE(license_id, 'anonymous') WHERE created_by_license_id IS NULL");
  await db.execute({ sql: 'UPDATE storms SET inactivity_hours = ? WHERE inactivity_hours IS NULL', args: [DEFAULT_INACTIVITY_HOURS] });
}

// show_connect is NULL until the presenter overrides it; then it follows the storm:
// the join screen shows while nobody has a question up and the storm is not closed.
export function connectVisible(storm, status = storm.status, currentQuestionId = storm.current_question_id) {
  if (storm.show_connect !== null && storm.show_connect !== undefined) return Number(storm.show_connect) === 1;
  return !currentQuestionId && status !== 'closed';
}

/** The presenter's chosen results-screen background (`#rrggbb`), or null for the default theme. */
export function resultsBackground(storm) {
  return storm?.results_background || null;
}

export async function touchStormActivity(db, stormCode) {
  await db.execute({
    sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?',
    args: [Date.now(), stormCode],
  });
}

/** A storm expires after its own inactivity window (set by the license it was created under). */
export function isStormExpired(storm, now = Date.now()) {
  const last = Number(storm.last_activity_at ?? storm.created_at);
  const hours = Number(storm.inactivity_hours ?? DEFAULT_INACTIVITY_HOURS);
  return now - last > hours * 3600000;
}

/** Removes every vote in a storm with one statement, however many questions it has. */
export async function deleteVotesForStorm(db, stormCode) {
  await db.execute({ sql: 'DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE storm_code = ?)', args: [stormCode] });
}

export async function deleteStormCascade(db, stormCode) {
  await db.batch(
    [
      { sql: 'DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE storm_code = ?)', args: [stormCode] },
      { sql: 'DELETE FROM questions WHERE storm_code = ?', args: [stormCode] },
      { sql: 'DELETE FROM storms WHERE storm_code = ?', args: [stormCode] },
    ],
    'write',
  );
}

export async function sweepExpiredStorms(db, now = Date.now()) {
  const expiredResult = await db.execute({
    sql: 'SELECT storm_code FROM storms WHERE COALESCE(last_activity_at, created_at) + COALESCE(inactivity_hours, ?) * 3600000 < ?',
    args: [DEFAULT_INACTIVITY_HOURS, now],
  });
  for (const row of expiredResult.rows) {
    await deleteStormCascade(db, row.storm_code);
  }
  // Rate-limit counters only matter for the window they belong to.
  await db.execute({ sql: 'DELETE FROM rate_limits WHERE window_start < ?', args: [now - 2 * 3600000] });
  return expiredResult.rows.length;
}

// Looked-up storms that have outlived their inactivity window are removed on contact, so expiry does not
// depend on the periodic sweep having run.
async function liveStorm(db, storm) {
  if (storm && isStormExpired(storm)) {
    await deleteStormCascade(db, storm.storm_code);
    return null;
  }
  return storm || null;
}

export async function getStormByCode(db, stormCode) {
  const result = await db.execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stormCode] });
  return liveStorm(db, result.rows[0]);
}

export async function getStormByAdminKeyHash(db, adminKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM storms WHERE admin_key_hash = ?', args: [adminKeyHash] });
  return liveStorm(db, result.rows[0]);
}

export async function getStormByResultsKeyHash(db, resultsKeyHash) {
  const result = await db.execute({ sql: 'SELECT * FROM storms WHERE results_key_hash = ?', args: [resultsKeyHash] });
  return liveStorm(db, result.rows[0]);
}
