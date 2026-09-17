import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const roomCode = event.queryStringParameters?.roomCode;
  if (!roomCode) {
    return json(400, { error: 'roomCode is required' });
  }

  const db = createDb();
  await initSchema(db);
  const room = await getRoomByCode(db, roomCode);
  if (!room) {
    return json(404, { error: 'Room not found' });
  }

  if (!room.current_question_id) {
    return json(200, { status: room.status, currentQuestion: null, tally: null });
  }

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ?',
    args: [room.current_question_id],
  });
  const question = questionResult.rows[0];

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [question.id],
  });

  const tally = computeTally(question, votesResult.rows);

  return json(200, {
    status: room.status,
    currentQuestion: {
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      options: question.options ? JSON.parse(question.options) : null,
      scaleMin: question.scale_min,
      scaleMax: question.scale_max,
    },
    tally,
  });
}
