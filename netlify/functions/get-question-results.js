import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const { roomCode, questionId } = event.queryStringParameters || {};
  if (!roomCode || !questionId) {
    return json(400, { error: 'roomCode and questionId are required' });
  }

  const db = createDb();
  await initSchema(db);
  const room = await getRoomByCode(db, roomCode);
  if (!room) return json(404, { error: 'Room not found' });

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
    args: [questionId, room.room_code],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });

  const live = room.status === 'active' && Number(room.current_question_id) === Number(question.id);
  const reveal = room.status === 'closed';
  if (!live && !reveal) {
    return json(200, { status: room.status, live: false, question: null, tally: null });
  }

  const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [question.id] });
  return json(200, {
    status: room.status,
    live,
    question: shapeQuestion(question, { reveal }),
    tally: publicTally(question, computeTally(question, votesResult.rows), { reveal }),
  });
}
