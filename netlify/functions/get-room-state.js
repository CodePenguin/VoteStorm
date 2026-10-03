import { createDb, initSchema, getRoomByCode, connectVisible } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
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
    return json(200, { status: room.status, currentQuestion: null, tally: null, showConnect: connectVisible(room) });
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

  const reveal = room.status === 'closed';
  return json(200, {
    status: room.status,
    currentQuestion: shapeQuestion(question, { reveal }),
    tally: publicTally(question, tally, { reveal }),
    showConnect: connectVisible(room),
  });
}
