import { createDb, initSchema, getStormByResultsKeyHash, touchStormActivity, connectVisible, resultsBackground } from '../../lib/db.js';
import { hashResultsKey } from '../../lib/stormCode.js';
import { computeTally } from '../../lib/tally.js';
import { shapeCloud, publicTally } from '../../lib/cloud.js';
import { publishEvent } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

// Makes a cloud live from a slide's results link (never reopens a closed storm). Needs the results key, which only the
// presenter hands out, so a guessed storm code can never switch the live cloud.
export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const { resultsKey, cloudId } = body;
  if (!resultsKey || !cloudId) return json(400, { error: 'resultsKey and cloudId are required' });

  const db = createDb();
  await initSchema(db);
  const storm = await getStormByResultsKeyHash(db, hashResultsKey(resultsKey));
  if (!storm) return json(401, { error: 'Invalid results key' });

  const cloudResult = await db.execute({
    sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
    args: [cloudId, storm.storm_code],
  });
  const cloud = cloudResult.rows[0];
  if (!cloud) return json(404, { error: 'Cloud not found' });

  // A closed storm stays closed: opening a slide link after the session only shows final results.
  if (storm.status === 'closed') return json(200, { ok: true, changed: false, closed: true });

  if (storm.status === 'active' && Number(storm.current_cloud_id) === Number(cloud.id)) {
    return json(200, { ok: true, changed: false });
  }

  await touchStormActivity(db, storm.storm_code);
  await db.execute({
    sql: `UPDATE storms SET status = 'active', current_cloud_id = ?, show_connect = NULL WHERE storm_code = ?`,
    args: [cloud.id, storm.storm_code],
  });
  // A cloud that comes live starts open, whatever lock or timer it had before.
  await db.execute({ sql: 'UPDATE clouds SET closes_at = NULL WHERE id = ?', args: [cloud.id] });
  const votes = (await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [cloud.id] })).rows;
  await publishEvent(storm.storm_code, 'state', {
    status: 'active',
    currentCloud: shapeCloud({ ...cloud, closes_at: null }),
    initialTally: publicTally(cloud, computeTally(cloud, votes)),
    showConnect: connectVisible({ show_connect: null }, 'active', cloud.id),
    resultsBackground: resultsBackground(storm),
  });
  return json(200, { ok: true, changed: true });
}
