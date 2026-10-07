import { createDb, initSchema, getStormByCode, touchStormActivity } from '../../lib/db.js';
import { stormLicense } from '../../lib/license.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { publicTally, votingClosed } from '../../lib/question.js';
import { rateLimit, rateLimitByIp } from '../../lib/rateLimit.js';
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
  const { stormCode, questionId, deviceId, value } = body;
  if (!stormCode || !questionId || !deviceId || value === undefined) {
    return json(400, { error: 'stormCode, questionId, deviceId, value are required' });
  }

  if (typeof deviceId !== 'string' || !/^[\w-]{1,100}$/.test(deviceId)) {
    return json(400, { error: 'Invalid deviceId' });
  }

  const db = createDb();
  await initSchema(db);
  const limited = (await rateLimitByIp(db, event, 'voteByIp')) || (await rateLimit(db, 'voteByDevice', deviceId));
  if (limited) return limited;

  const storm = await getStormByCode(db, stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });
  if (storm.status !== 'active' || Number(storm.current_question_id) !== Number(questionId)) {
    return json(409, { error: 'This question is not currently active', code: 'not_active' });
  }

  const questionResult = await db.execute({
    sql: 'SELECT * FROM questions WHERE id = ?',
    args: [questionId],
  });
  const question = questionResult.rows[0];
  if (!question) return json(404, { error: 'Question not found' });
  if (votingClosed(question)) return json(409, { error: 'Voting has closed for this question.', code: 'voting_closed' });

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

  const { maxAudiencePerStorm } = stormLicense(storm);
  if (maxAudiencePerStorm) {
    const audience = await db.execute({
      sql: `SELECT COUNT(DISTINCT v.device_id) AS n, MAX(v.device_id = ?) AS mine
            FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.storm_code = ?`,
      args: [deviceId, storm.storm_code],
    });
    const { n, mine } = audience.rows[0];
    if (!Number(mine) && Number(n) >= maxAudiencePerStorm) {
      return json(403, { error: 'This Storm has reached its audience limit.', code: 'audience_full' });
    }
  }

  // A device may change its answer while the question is live: one row per device, replaced on resubmit.
  await db.execute({
    sql: `INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(question_id, device_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    args: [questionId, deviceId, storedValue, Date.now()],
  });

  await touchStormActivity(db, storm.storm_code);
  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE question_id = ?',
    args: [questionId],
  });
  const tally = computeTally(question, votesResult.rows);

  const shown = publicTally(question, tally);
  await publishEvent(stormCode, 'tally', { questionId, ...shown });

  return json(200, { ok: true, tally: shown });
}
