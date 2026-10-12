import { createDb, initSchema } from '../../lib/db.js';
import { ConfigError, LicenseError, configErrorResponse, resolveLicense } from '../../lib/license.js';
import { createPairTokenRequest } from '../../lib/realtime.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

// Hands out an Ably token for one pairing channel (see src/lib/pairing.ts). The channel id is derived in the browsers from a
// code the server never sees, and nothing about a pairing is stored: the only database write is the rate-limit counter.
// Syncing is a licensed feature, so the license is checked first and the limit is counted per license, not per address.
export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const id = event.queryStringParameters?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return json(400, { error: 'id must be 64 lowercase hex characters' });

  let license;
  try {
    license = await resolveLicense(event);
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    if (err instanceof ConfigError) return configErrorResponse(err, json);
    throw err;
  }
  // The anonymous tier is shared by everyone, so it is turned away before anything touches the database.
  if (license.tier !== 'licensed' || license.id === 'anonymous') {
    return json(403, { error: 'Syncing needs a license.', code: 'license_required' });
  }

  const db = createDb();
  await initSchema(db);
  const limited = await rateLimit(db, 'pairToken', license.id);
  if (limited) return limited;

  return json(200, await createPairTokenRequest(id));
}
