import { createDb, initSchema, sweepExpiredStorms } from '../../lib/db.js';
import { ConfigError, LicenseError, configErrorResponse, resolveLicense } from '../../lib/license.js';
import { insertStorm, stormLimitResponse } from '../../lib/storms.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

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

  const full = await stormLimitResponse(db, license);
  if (full) return full;

  const created = await insertStorm(db, license);
  if (!created) return json(503, { error: 'Could not allocate a Storm code. Please try again.' });
  return json(200, created);
}
