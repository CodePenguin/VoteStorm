import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

// libSQL surfaces a UNIQUE constraint violation as a LibsqlError whose
// `code` starts with SQLITE_CONSTRAINT (e.g. SQLITE_CONSTRAINT_UNIQUE) on the
// local sqlite3 driver, and whose `message` still names the constraint on
// the remote hrana/http drivers. Check both so we only treat an actual
// duplicate-vote conflict as a 409, and let any other error (transient DB
// failure, etc.) propagate.
function isUniqueConstraintError(error) {
  if (!error) return false;
  if (typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) return true;
  if (typeof error.message === 'string' && /unique constraint/i.test(error.message)) return true;
  return false;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const { roomCode, questionId, deviceId, value } = body;
  if (!roomCode || !questionId || !deviceId || value === undefined) {
    return json(400, { error: 'roomCode, questionId, deviceId, value are required' });
  }

  const db = createDb();
  await initSchema(db);

  const room = await getRoomByCode(db, roomCode);
  if (!room) return json(404, { error: 'Room not found' });
  if (room.status !== 'active' || Number(room.current_question_id) !== Number(questionId)) {
    return json(409, { error: 'This question is not currently active', code: 'not_active' });
  }

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ?',
    args: [questionId],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });

  const numericValue = Number(value);
  if (question.type === 'choice') {
    const options = JSON.parse(question.options);
    if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue >= options.length) {
      return json(400, { error: 'Invalid vote value' });
    }
  } else if (question.type === 'rating') {
    if (!Number.isInteger(numericValue) || numericValue < question.scale_min || numericValue > question.scale_max) {
      return json(400, { error: 'Invalid vote value' });
    }
  }

  try {
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [questionId, deviceId, String(value), Date.now()],
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return json(409, { error: 'Already voted on this question', code: 'already_voted' });
    }
    throw error;
  }

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [questionId],
  });
  const tally = computeTally(question, votesResult.rows);

  await publishEvent(roomCode, 'tally', { questionId, ...tally });

  return json(200, { ok: true, tally });
}
