import { createDb, initSchema, getStormByCode, connectVisible } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const stormCode = event.queryStringParameters?.stormCode;
  if (!stormCode) {
    return json(400, { error: 'stormCode is required' });
  }

  const db = createDb();
  await initSchema(db);
  const storm = await getStormByCode(db, stormCode);
  if (!storm) {
    return json(404, { error: 'Storm not found' });
  }

  if (!storm.current_question_id) {
    return json(200, { status: storm.status, currentQuestion: null, tally: null, showConnect: connectVisible(storm) });
  }

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ?',
    args: [storm.current_question_id],
  });
  const question = questionResult.rows[0];
  if (!question) {
    // The storm points at a question that no longer exists: treat it as nothing being live.
    return json(200, { status: storm.status, currentQuestion: null, tally: null, showConnect: connectVisible(storm) });
  }

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [question.id],
  });

  const tally = computeTally(question, votesResult.rows);

  const reveal = storm.status === 'closed';
  return json(200, {
    status: storm.status,
    currentQuestion: shapeQuestion(question, { reveal }),
    tally: publicTally(question, tally, { reveal }),
    showConnect: connectVisible(storm),
  });
}
