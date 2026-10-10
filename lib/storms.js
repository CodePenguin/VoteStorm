import { generateStormCode } from './stormCode.js';
import { isResultsKeyHash, parsePublicKey, publicKeyHash } from './adminAuth.js';
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

/** The credentials a browser registers for a new Storm. Returns them, or { error } with a message fit for a 400. */
export function parseNewCredentials(body) {
  const { publicKey, resultsKeyHash } = body ?? {};
  if (!parsePublicKey(publicKey)) return { error: 'publicKey must be a P-256 public key' };
  if (!isResultsKeyHash(resultsKeyHash)) return { error: 'resultsKeyHash must be a SHA-256 hex digest' };
  return { publicKey, resultsKeyHash };
}

/**
 * Creates a storm under `license` with the public key the browser generated. The code is random, so two storms can
 * (very rarely) collide; a new code is drawn if so. Returns { stormCode }, { inUse: true } if that public key already
 * belongs to a Storm, or null if no free code was found.
 */
export async function insertStorm(db, license, { publicKey, resultsKeyHash, resultsBackground = null, name = null }) {
  const keyHash = publicKeyHash(publicKey);
  const taken = await db.execute({ sql: 'SELECT 1 FROM storms WHERE admin_key_hash = ?', args: [keyHash] });
  if (taken.rows.length > 0) return { inUse: true };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stormCode = generateStormCode();
    const now = Date.now();
    try {
      await db.execute({
        sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, current_cloud_id, created_at, last_activity_at, results_key_hash, inactivity_hours, license_id, license_json,
                           created_by_license_id, created_by_license_name, results_background, name)
              VALUES (?, ?, ?, 'lobby', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          keyHash,
          publicKey,
          stormCode,
          now,
          now,
          resultsKeyHash,
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
      return { stormCode };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
  }
  return null;
}
