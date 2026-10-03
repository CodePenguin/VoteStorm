import { createDb, initSchema, getRoomByResultsKeyHash, touchRoomActivity, connectVisible } from '../../lib/db.js';
import { hashResultsKey } from '../../lib/roomCode.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { publishEvent } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

// Makes a question live from a slide's results link (never reopens a closed room). Needs the results key, which only the
// presenter hands out, so a guessed room code can never switch the live question.
export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const { resultsKey, questionId } = body;
  if (!resultsKey || !questionId) return json(400, { error: 'resultsKey and questionId are required' });

  const db = createDb();
  await initSchema(db);
  const room = await getRoomByResultsKeyHash(db, hashResultsKey(resultsKey));
  if (!room) return json(401, { error: 'Invalid results key' });

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
    args: [questionId, room.room_code],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });

  // A closed room stays closed: opening a slide link after the session only shows final results.
  if (room.status === 'closed') return json(200, { ok: true, changed: false, closed: true });

  if (room.status === 'active' && Number(room.current_question_id) === Number(question.id)) {
    return json(200, { ok: true, changed: false });
  }

  await touchRoomActivity(db, room.room_code);
  await db.execute({
    sql: `UPDATE rooms SET status = 'active', current_question_id = ?, show_connect = NULL WHERE room_code = ?`,
    args: [question.id, room.room_code],
  });
  const votes = (await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [question.id] })).rows;
  await publishEvent(room.room_code, 'state', {
    status: 'active',
    currentQuestion: shapeQuestion(question),
    initialTally: publicTally(question, computeTally(question, votes)),
    showConnect: connectVisible({ show_connect: null }, 'active', question.id),
  });
  return json(200, { ok: true, changed: true });
}
