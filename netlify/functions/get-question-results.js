import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const { stormCode, questionId } = event.queryStringParameters || {};
  if (!stormCode || !questionId) {
    return json(400, { error: 'stormCode and questionId are required' });
  }

  const db = createDb();
  await initSchema(db);
  const storm = await getStormByCode(db, stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ? AND storm_code = ?',
    args: [questionId, storm.storm_code],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });

  const live = storm.status === 'active' && Number(storm.current_question_id) === Number(question.id);
  const reveal = storm.status === 'closed';
  if (!live && !reveal) {
    return json(200, { status: storm.status, live: false, question: null, tally: null });
  }

  const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [question.id] });
  return json(200, {
    status: storm.status,
    live,
    question: shapeQuestion(question, { reveal }),
    tally: publicTally(question, computeTally(question, votesResult.rows), { reveal }),
  });
}
