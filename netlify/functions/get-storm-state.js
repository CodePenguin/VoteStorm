import { createDb, initSchema, getStormByCode, connectVisible } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { shapeCloud, publicTally } from '../../lib/cloud.js';
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

  if (!storm.current_cloud_id) {
    return json(200, { status: storm.status, currentCloud: null, tally: null, showConnect: connectVisible(storm) });
  }

  const cloudResult = await db.execute({
    sql: 'SELECT * FROM clouds WHERE id = ?',
    args: [storm.current_cloud_id],
  });
  const cloud = cloudResult.rows[0];
  if (!cloud) {
    // The storm points at a cloud that no longer exists: treat it as nothing being live.
    return json(200, { status: storm.status, currentCloud: null, tally: null, showConnect: connectVisible(storm) });
  }

  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE cloud_id = ?',
    args: [cloud.id],
  });

  const tally = computeTally(cloud, votesResult.rows);

  const reveal = storm.status === 'closed';
  return json(200, {
    status: storm.status,
    currentCloud: shapeCloud(cloud, { reveal }),
    tally: publicTally(cloud, tally, { reveal }),
    showConnect: connectVisible(storm),
  });
}
