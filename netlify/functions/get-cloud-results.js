import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeCloud, publicTally } from '../../lib/cloud.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const { stormCode, cloudId } = event.queryStringParameters || {};
  if (!stormCode || !cloudId) {
    return json(400, { error: 'stormCode and cloudId are required' });
  }

  const db = createDb();
  await initSchema(db);
  const storm = await getStormByCode(db, stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });

  const cloudResult = await db.execute({
    sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
    args: [cloudId, storm.storm_code],
  });
  const cloud = cloudResult.rows[0];
  if (!cloud) return json(404, { error: 'Cloud not found' });

  const live = storm.status === 'active' && Number(storm.current_cloud_id) === Number(cloud.id);
  const reveal = storm.status === 'closed';
  if (!live && !reveal) {
    return json(200, { status: storm.status, live: false, cloud: null, tally: null });
  }

  const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [cloud.id] });
  return json(200, {
    status: storm.status,
    live,
    cloud: shapeCloud(cloud, { reveal }),
    tally: publicTally(cloud, computeTally(cloud, votesResult.rows), { reveal }),
  });
}
