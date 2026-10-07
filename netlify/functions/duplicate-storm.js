import { createDb, initSchema, getStormByAdminKeyHash, sweepExpiredStorms, deleteStormCascade, resultsBackground } from '../../lib/db.js';
import { hashAdminKey } from '../../lib/stormCode.js';
import { ConfigError, LicenseError, configErrorResponse, resolveLicense } from '../../lib/license.js';
import { insertStorm, stormLimitResponse } from '../../lib/storms.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

// Copies a storm's questions and look into a brand new storm, with no votes and no lock or timer. The copy belongs to
// whoever asks (their license, their limits), so it counts toward their active-storm limit like any new storm.
export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!bodyData.adminKey || typeof bodyData.adminKey !== 'string') return json(401, { error: 'Invalid admin key' });

  let license;
  try {
    license = await resolveLicense(event);
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    if (err instanceof ConfigError) return configErrorResponse(err, json);
    throw err;
  }

  const db = createDb();
  await initSchema(db);
  const limited = await rateLimitByIp(db, event, 'createStorm');
  if (limited) return limited;
  await sweepExpiredStorms(db);

  const source = await getStormByAdminKeyHash(db, hashAdminKey(bodyData.adminKey));
  if (!source) return json(401, { error: 'Invalid admin key' });

  const questions = (await db.execute({ sql: 'SELECT * FROM questions WHERE storm_code = ? ORDER BY order_index ASC', args: [source.storm_code] })).rows;
  if (license.maxQuestionsPerStorm && questions.length > license.maxQuestionsPerStorm) {
    return json(403, {
      error: `This Storm has ${questions.length} questions, but your license allows ${license.maxQuestionsPerStorm} per Storm.`,
      code: 'question_limit',
    });
  }

  const full = await stormLimitResponse(db, license);
  if (full) return full;

  const created = await insertStorm(db, license, { resultsBackground: resultsBackground(source) });
  if (!created) return json(503, { error: 'Could not allocate a Storm code. Please try again.' });

  try {
    if (questions.length > 0) {
      const now = Date.now();
      await db.batch(
        questions.map((q) => ({
          sql: `INSERT INTO questions (storm_code, order_index, type, prompt, options, scale_min, scale_max, multi, results_hidden, answer_shown, correct, display, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [created.stormCode, q.order_index, q.type, q.prompt, q.options, q.scale_min, q.scale_max, q.multi, q.results_hidden, q.answer_shown, q.correct, q.display, now],
        })),
        'write',
      );
    }
  } catch (err) {
    // Never leave a half-copied storm behind.
    await deleteStormCascade(db, created.stormCode);
    throw err;
  }
  return json(200, created);
}
