import { ConfigError, LicenseError, configErrorResponse, describeLicense, resolveLicense } from '../../lib/license.js';
import { createDb, initSchema, sweepExpiredStorms } from '../../lib/db.js';
import { countActiveStorms } from '../../lib/storms.js';
import { json } from '../../lib/http.js';

// Tells the presenter which license (or the anonymous tier) their token puts them under, and how much of its Storm
// allowance is in use. The anonymous tier's allowance is shared by the whole server, so its count is the server's.
export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  try {
    const license = await resolveLicense(event);
    const db = createDb();
    await initSchema(db);
    await sweepExpiredStorms(db);
    return json(200, { ...describeLicense(license), usage: { activeStorms: await countActiveStorms(db, license) } });
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    if (err instanceof ConfigError) return configErrorResponse(err, json);
    throw err;
  }
}
