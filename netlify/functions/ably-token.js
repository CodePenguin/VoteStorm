import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { createTokenRequest } from '../../lib/realtime.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const stormCode = event.queryStringParameters?.stormCode;
  if (!stormCode) return json(400, { error: 'stormCode is required' });

  // Optional: lets a voter's browser join the storm's presence set (live "connected" count).
  const rawClientId = event.queryStringParameters?.clientId;
  const clientId = rawClientId && /^[\w-]{1,100}$/.test(rawClientId) ? rawClientId : undefined;

  const db = createDb();
  await initSchema(db);
  const limited = await rateLimitByIp(db, event, 'realtimeToken');
  if (limited) return limited;
  // Tokens are only for storms that exist, so the channel space cannot be probed or flooded with made-up names.
  const storm = await getStormByCode(db, stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });

  const tokenRequest = await createTokenRequest(storm.storm_code, clientId);
  return json(200, tokenRequest);
}
