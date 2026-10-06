import { createDb, initSchema, getStormByResultsKeyHash } from '../../lib/db.js';
import { hashResultsKey } from '../../lib/stormCode.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const key = event.queryStringParameters?.key;
  if (!key) return json(400, { error: 'key is required' });

  const db = createDb();
  await initSchema(db);
  const storm = await getStormByResultsKeyHash(db, hashResultsKey(key));
  if (!storm) return json(404, { error: 'Results not found' });
  return json(200, { stormCode: storm.storm_code });
}
