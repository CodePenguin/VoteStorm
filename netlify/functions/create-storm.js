import { generateAdminKey, hashAdminKey, deriveStormCode, deriveResultsKey, hashResultsKey } from '../../lib/stormCode.js';
import { createDb, initSchema, isUniqueConstraintError, sweepExpiredStorms } from '../../lib/db.js';
import { ConfigError, LicenseError, configErrorResponse, licenseSnapshot, resolveLicense } from '../../lib/license.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

const MAX_ATTEMPTS = 5;

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

  // Storms are counted per license, by the license that created them. The anonymous tier is a license too, so its
  // limit caps the anonymous storms on the whole server.
  if (license.maxActiveStorms) {
    const result = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM storms WHERE created_by_license_id = ?', args: [license.id] });
    if (Number(result.rows[0].n) >= license.maxActiveStorms) {
      const plural = license.maxActiveStorms === 1 ? '' : 's';
      return json(403, {
        error: license.tier === 'licensed'
          ? `Your license allows ${license.maxActiveStorms} active Storm${plural}. Delete or let one expire first.`
          : `This server is at its limit of ${license.maxActiveStorms} active Storm${plural}. Please try again later.`,
        code: 'storm_limit',
      });
    }
  }

  // The short storm code comes from the admin key, so two storms can (rarely) collide; draw a new key if so.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const adminKey = generateAdminKey();
    const stormCode = deriveStormCode(adminKey);
    const now = Date.now();
    try {
      await db.execute({
        sql: `INSERT INTO storms (admin_key_hash, storm_code, status, current_question_id, created_at, last_activity_at, results_key_hash, inactivity_hours, license_id, license_json,
                           created_by_license_id, created_by_license_name)
              VALUES (?, ?, 'lobby', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          hashAdminKey(adminKey),
          stormCode,
          now,
          now,
          hashResultsKey(deriveResultsKey(adminKey)),
          license.stormInactivityHours,
          license.tier === 'licensed' ? license.id : null,
          licenseSnapshot(license),
          // Who created the storm, for good: unlike license_json this is not replaced if a different license is presented later.
          license.id,
          license.name,
        ],
      });
      return json(200, { adminKey, stormCode });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
  }
  return json(503, { error: 'Could not allocate a Storm code. Please try again.' });
}
