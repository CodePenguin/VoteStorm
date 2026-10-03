import { generateAdminKey, hashAdminKey, deriveRoomCode, deriveResultsKey, hashResultsKey } from '../../lib/roomCode.js';
import { createDb, initSchema, sweepExpiredRooms } from '../../lib/db.js';
import { LicenseError, licenseSnapshot, resolveLicense } from '../../lib/license.js';
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
    throw err;
  }

  const db = createDb();
  await initSchema(db);
  await sweepExpiredRooms(db);

  // Rooms are counted per license; the anonymous tier has no identity to count against.
  if (license.tier === 'licensed' && license.maxActiveRooms) {
    const result = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM rooms WHERE license_id = ?', args: [license.id] });
    if (Number(result.rows[0].n) >= license.maxActiveRooms) {
      return json(403, {
        error: `Your license allows ${license.maxActiveRooms} active room${license.maxActiveRooms === 1 ? '' : 's'}. Delete or let one expire first.`,
        code: 'room_limit',
      });
    }
  }

  const adminKey = generateAdminKey();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO rooms (admin_key_hash, room_code, status, current_question_id, created_at, last_activity_at, results_key_hash, inactivity_hours, license_id, license_json)
          VALUES (?, ?, 'lobby', NULL, ?, ?, ?, ?, ?, ?)`,
    args: [
      hashAdminKey(adminKey),
      deriveRoomCode(adminKey),
      now,
      now,
      hashResultsKey(deriveResultsKey(adminKey)),
      license.roomInactivityHours,
      license.tier === 'licensed' ? license.id : null,
      licenseSnapshot(license),
    ],
  });

  return json(200, { adminKey, roomCode: deriveRoomCode(adminKey) });
}
