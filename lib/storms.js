import { generateAdminKey, hashAdminKey, deriveStormCode, deriveResultsKey, hashResultsKey } from './stormCode.js';
import { isUniqueConstraintError } from './db.js';
import { licenseSnapshot } from './license.js';
import { json } from './http.js';

const MAX_ATTEMPTS = 5;
export const MAX_NAME_LENGTH = 80;

/** A storm name as stored: trimmed, at most MAX_NAME_LENGTH characters, empty meaning none (null). Undefined if it is not a usable name. */
export function normalizeStormName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) return undefined;
  return name === '' ? null : name;
}

/**
 * Storms are counted per license, by the license that created them. The anonymous tier is a license too, so its limit
 * caps the anonymous storms on the whole server. Returns null if there is room, else the 403 response to send.
 */
export async function stormLimitResponse(db, license) {
  if (!license.maxActiveStorms) return null;
  const result = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM storms WHERE created_by_license_id = ?', args: [license.id] });
  if (Number(result.rows[0].n) < license.maxActiveStorms) return null;
  const plural = license.maxActiveStorms === 1 ? '' : 's';
  return json(403, {
    error: license.tier === 'licensed'
      ? `Your license allows ${license.maxActiveStorms} active Storm${plural}. Delete or let one expire first.`
      : `This server is at its limit of ${license.maxActiveStorms} active Storm${plural}. Please try again later.`,
    code: 'storm_limit',
  });
}

/**
 * Creates a storm under `license`. The short storm code comes from the admin key, so two storms can (rarely) collide;
 * a new key is drawn if so. Returns { adminKey, stormCode }, or null if no free code was found.
 */
export async function insertStorm(db, license, { resultsBackground = null, name = null } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const adminKey = generateAdminKey();
    const stormCode = deriveStormCode(adminKey);
    const now = Date.now();
    try {
      await db.execute({
        sql: `INSERT INTO storms (admin_key_hash, storm_code, status, current_question_id, created_at, last_activity_at, results_key_hash, inactivity_hours, license_id, license_json,
                           created_by_license_id, created_by_license_name, results_background, name)
              VALUES (?, ?, 'lobby', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          resultsBackground,
          name,
        ],
      });
      return { adminKey, stormCode };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
  }
  return null;
}
