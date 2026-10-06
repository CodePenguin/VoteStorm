import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeQuestion } from '../../lib/question.js';
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
  if (storm.status !== 'closed') {
    return json(403, { error: 'Results are available once the Storm is closed' });
  }

  const questionsResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE storm_code = ? ORDER BY order_index ASC',
    args: [storm.storm_code],
  });
  const votesResult = await db.execute({
    sql: `SELECT v.* FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.storm_code = ?`,
    args: [storm.storm_code],
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
