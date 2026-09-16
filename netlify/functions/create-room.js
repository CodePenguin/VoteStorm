import { generateAdminKey, hashAdminKey, deriveRoomCode } from '../../lib/roomCode.js';
import { createDb, initSchema } from '../../lib/db.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const adminKey = generateAdminKey();
  const adminKeyHash = hashAdminKey(adminKey);
  const roomCode = deriveRoomCode(adminKey);

  const db = createDb();
  await initSchema(db);
  await db.execute({
    sql: `INSERT INTO rooms (admin_key_hash, room_code, status, current_question_id, created_at)
          VALUES (?, ?, 'lobby', NULL, ?)`,
    args: [adminKeyHash, roomCode, Date.now()],
  });

  return json(200, { adminKey, roomCode });
}
