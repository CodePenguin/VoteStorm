import { createDb, initSchema, getRoomByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion } from '../../lib/question.js';
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
  if (room.status !== 'closed') {
    return json(403, { error: 'Results are available once the room is closed' });
  }

  const questionsResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE room_code = ? ORDER BY order_index ASC',
    args: [room.room_code],
  });
  const votesResult = await db.execute({
    sql: `SELECT v.* FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.room_code = ?`,
    args: [room.room_code],
  });

  const votesByQuestion = new Map();
  for (const vote of votesResult.rows) {
    const list = votesByQuestion.get(Number(vote.question_id)) || [];
    list.push(vote);
    votesByQuestion.set(Number(vote.question_id), list);
  }

  const questions = questionsResult.rows.map((q) => ({
    ...shapeQuestion(q, { reveal: true }),
    tally: computeTally(q, votesByQuestion.get(Number(q.id)) || []),
  }));

  return json(200, { questions });
}
