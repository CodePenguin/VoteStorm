import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
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
    return json(409, { error: 'This question is not currently active' });
  }

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ?',
    args: [questionId],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });

  try {
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [questionId, deviceId, String(value), Date.now()],
    });
  } catch {
    return json(409, { error: 'Already voted on this question' });
  }

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [questionId],
  });
  const tally = computeTally(question, votesResult.rows);

  await publishEvent(roomCode, 'tally', { questionId, ...tally });

  return json(200, { ok: true, tally });
}
