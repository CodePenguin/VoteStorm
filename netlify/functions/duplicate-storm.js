import { createDb, initSchema, sweepExpiredStorms, deleteStormCascade, resultsBackground } from '../../lib/db.js';
import { ConfigError, LicenseError, configErrorResponse, resolveLicense } from '../../lib/license.js';
import { insertStorm, parseNewCredentials, stormLimitResponse, MAX_NAME_LENGTH } from '../../lib/storms.js';
import { verifyAdmin } from '../../lib/adminAuth.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

// Copies a storm's clouds and look into a brand new storm, with no votes and no lock or timer. The copy belongs to
// whoever asks (their license, their limits), so it counts toward their active-storm limit like any new storm.
export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let license;
  try {
    license = await resolveLicense(event);
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    if (err instanceof ConfigError) return configErrorResponse(err, json);
    throw err;
  }

  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const credentials = parseNewCredentials(bodyData);
  if (credentials.error) return json(400, { error: credentials.error });

  const db = createDb();
  await initSchema(db);
  const limited = await rateLimitByIp(db, event, 'createStorm');
  if (limited) return limited;
  await sweepExpiredStorms(db);

  const auth = await verifyAdmin(event, db, 'duplicate-storm');
  if (auth.response) return auth.response;
  const source = auth.storm;

  const clouds = (await db.execute({ sql: 'SELECT * FROM clouds WHERE storm_code = ? ORDER BY order_index ASC', args: [source.storm_code] })).rows;
  if (license.maxQuestionsPerStorm && clouds.length > license.maxQuestionsPerStorm) {
    return json(403, {
      error: `This Storm has ${clouds.length} clouds, but your license allows ${license.maxQuestionsPerStorm} per Storm.`,
      code: 'cloud_limit',
    });
  }

  const full = await stormLimitResponse(db, license);
  if (full) return full;

  const created = await insertStorm(db, license, {
    ...credentials,
    resultsBackground: resultsBackground(source),
    name: source.name ? `Copy of ${source.name}`.slice(0, MAX_NAME_LENGTH) : null,
  });
  if (!created) return json(503, { error: 'Could not allocate a Storm code. Please try again.' });
  if (created.inUse) return json(409, { error: 'That key is already in use' });

  try {
    if (clouds.length > 0) {
      const now = Date.now();
      await db.batch(
        clouds.map((q) => ({
          sql: `INSERT INTO clouds (storm_code, order_index, kind, body, options, scale_min, scale_max, multi, results_hidden, answer_shown, correct, display, max_words, hidden_words, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [created.stormCode, q.order_index, q.kind, q.body, q.options, q.scale_min, q.scale_max, q.multi, q.results_hidden, q.answer_shown, q.correct, q.display, q.max_words, q.hidden_words, now],
        })),
        'write',
      );
    }
  } catch (err) {
    // Never leave a half-copied storm behind.
    await deleteStormCascade(db, created.stormCode);
    throw err;
  }
  return json(200, { stormCode: created.stormCode });
}
