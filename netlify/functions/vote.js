import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { publicTally } from '../../lib/question.js';
import { json } from '../../lib/http.js';

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
  let storedValue = String(value);
  if (question.type === 'choice' && question.multi) {
    const options = JSON.parse(question.options);
    const picks = Array.isArray(value) ? value.map(Number) : null;
    if (!picks || picks.length === 0 || !picks.every((n) => Number.isInteger(n) && n >= 0 && n < options.length)) {
      return json(400, { error: 'Invalid vote value' });
    }
    storedValue = JSON.stringify([...new Set(picks)].sort((a, b) => a - b));
  } else if (question.type === 'choice') {
    const options = JSON.parse(question.options);
    if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue >= options.length) {
      return json(400, { error: 'Invalid vote value' });
    }
  } else if (question.type === 'rating') {
    if (!Number.isInteger(numericValue) || numericValue < question.scale_min || numericValue > question.scale_max) {
      return json(400, { error: 'Invalid vote value' });
    }
  }

  // A device may change its answer while the question is live: one row per device, replaced on resubmit.
  await db.execute({
    sql: `INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(question_id, device_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    args: [questionId, deviceId, storedValue, Date.now()],
  });

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [questionId],
  });
  const tally = computeTally(question, votesResult.rows);

  const shown = publicTally(question, tally);
  await publishEvent(roomCode, 'tally', { questionId, ...shown });

  return json(200, { ok: true, tally: shown });
}
