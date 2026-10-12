import { createDb, initSchema, getStormByCode, sweepExpiredStorms, deleteStormCascade, isUniqueConstraintError } from '../../lib/db.js';
import { publicKeyHash } from '../../lib/adminAuth.js';
import { ConfigError, DEFAULT_INACTIVITY_HOURS, LicenseError, configErrorResponse, resolveLicense } from '../../lib/license.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { parseNewCredentials } from '../../lib/storms.js';
import { json } from '../../lib/http.js';

// A reclaim carries a public key and a hash; nothing legitimate is anywhere near this large.
const MAX_BODY_BYTES = 2048;

/**
 * Lists, reclaims and deletes the Storms created under the presented license. The license token is the authority here
 * (a Storm's own secret may be lost); Storms are matched on the license that created them, never the one most
 * recently presented. The anonymous tier is shared by everyone, so it can do none of this.
 */
export async function handler(event) {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return json(405, { error: 'Method not allowed' });

  let license;
  try {
    license = await resolveLicense(event);
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    if (err instanceof ConfigError) return configErrorResponse(err, json);
    throw err;
  }
  if (license.tier !== 'licensed' || license.id === 'anonymous') {
    return json(403, { error: 'This needs a license.', code: 'license_required' });
  }

  const db = createDb();
  await initSchema(db);
  const limited = await rateLimitByIp(db, event, 'licenseStorms');
  if (limited) return limited;
  await sweepExpiredStorms(db);

  if (method === 'GET') {
    const result = await db.execute({
      sql: `SELECT s.storm_code, s.name, s.status, s.created_at, s.last_activity_at, s.inactivity_hours,
                   (SELECT COUNT(*) FROM clouds c WHERE c.storm_code = s.storm_code) AS cloud_count
            FROM storms s WHERE s.created_by_license_id = ?
            ORDER BY COALESCE(s.last_activity_at, s.created_at) DESC`,
      args: [license.id],
    });
    const storms = result.rows.map((s) => {
      const lastActivityAt = Number(s.last_activity_at ?? s.created_at);
      return {
        stormCode: s.storm_code,
        name: s.name ?? null,
        status: s.status,
        cloudCount: Number(s.cloud_count),
        lastActivityAt,
        expiresAt: lastActivityAt + Number(s.inactivity_hours ?? DEFAULT_INACTIVITY_HOURS) * 3600000,
      };
    });
    return json(200, { storms });
  }

  if ((event.body || '').length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' });
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (method === 'POST') {
    const credentials = parseNewCredentials(body);
    if (credentials.error) return json(400, { error: credentials.error });
    const storm = await ownedStorm(db, license, body?.stormCode);
    if (!storm) return json(404, { error: 'Storm not found' });
    let updated;
    try {
      updated = await db.execute({
        sql: `UPDATE storms SET admin_key_hash = ?, admin_public_key = ?, results_key_hash = ?, last_activity_at = ?
              WHERE storm_code = ? AND created_by_license_id = ?`,
        args: [
          publicKeyHash(credentials.publicKey), credentials.publicKey, credentials.resultsKeyHash, Date.now(),
          storm.storm_code, license.id,
        ],
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) return json(409, { error: 'That key is already in use' });
      throw err;
    }
    if (updated.rowsAffected === 0) return json(404, { error: 'Storm not found' });
    return json(200, { ok: true });
  }

  const storm = await ownedStorm(db, license, body?.stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });
  await deleteStormCascade(db, storm.storm_code);
  return json(200, { ok: true });
}

/** The Storm, if it exists and was created under this license. Anything else, including a non-text code, is just "not found". */
async function ownedStorm(db, license, stormCode) {
  if (typeof stormCode !== 'string') return null;
  const storm = await getStormByCode(db, stormCode);
  return storm && storm.created_by_license_id === license.id ? storm : null;
}
