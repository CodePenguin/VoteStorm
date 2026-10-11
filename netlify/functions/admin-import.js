import { createDb, initSchema, connectVisible } from '../../lib/db.js';
import { verifyAdmin } from '../../lib/adminAuth.js';
import { applyPresentedLicense } from '../../lib/license.js';
import { publishEvent } from '../../lib/realtime.js';
import { MAX_IMPORT_BYTES, parseStormFile } from '../../lib/stormFile.js';
import { json } from '../../lib/http.js';

// Replaces a Storm's shape (name, results background, clouds) with a Storm file's. Everything in the file is checked
// again here, and the swap is one batch: if anything fails the Storm is exactly as it was. The session starts over: no
// live cloud, no lock or timer, no votes, no removed words.
export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if ((event.body?.length ?? 0) > MAX_IMPORT_BYTES) return json(413, { error: 'This file is too large to import', code: 'too_large' });

  const db = createDb();
  await initSchema(db);

  const auth = await verifyAdmin(event, db, 'admin-import');
  if (auth.response) return auth.response;
  const { storm } = auth;

  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const parsed = parseStormFile(bodyData?.storm);
  if (parsed.error) return json(400, { error: parsed.error });
  const { name, resultsBackground, clouds } = parsed.value;

  const license = await applyPresentedLicense(db, storm, event);
  if (license.maxQuestionsPerStorm && clouds.length > license.maxQuestionsPerStorm) {
    return json(403, {
      error: `This file has ${clouds.length} clouds, but your license allows ${license.maxQuestionsPerStorm} per Storm.`,
      code: 'cloud_limit',
    });
  }

  const code = storm.storm_code;
  const status = storm.status === 'closed' ? 'closed' : 'lobby';
  const now = Date.now();
  await db.batch(
    [
      { sql: 'DELETE FROM votes WHERE cloud_id IN (SELECT id FROM clouds WHERE storm_code = ?)', args: [code] },
      { sql: 'DELETE FROM clouds WHERE storm_code = ?', args: [code] },
      ...clouds.map((q, i) => ({
        sql: `INSERT INTO clouds (storm_code, order_index, kind, body, options, scale_min, scale_max, multi, results_hidden, correct, display, max_words, timer_seconds, timer_auto, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [code, i, q.kind, q.body, q.options ? JSON.stringify(q.options) : null, q.scaleMin, q.scaleMax, q.multi, q.resultsHidden, q.correct, q.display, q.maxWords, q.timerSeconds, q.timerAuto, now],
      })),
      {
        sql: 'UPDATE storms SET name = ?, results_background = ?, status = ?, current_cloud_id = NULL, show_connect = NULL, last_activity_at = ? WHERE storm_code = ?',
        args: [name, resultsBackground, status, now, code],
      },
    ],
    'write',
  );

  await publishEvent(code, 'state', {
    status,
    currentCloud: null,
    initialTally: null,
    showConnect: connectVisible({ show_connect: null }, status, null),
    resultsBackground,
  });
  return json(200, { ok: true, clouds: clouds.length });
}
