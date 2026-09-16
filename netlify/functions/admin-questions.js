import { createDb, initSchema, getRoomByAdminKeyHash } from '../../lib/db.js';
import { hashAdminKey } from '../../lib/roomCode.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  const db = createDb();
  await initSchema(db);

  const params = event.queryStringParameters || {};
  const bodyData = event.body ? JSON.parse(event.body) : {};
  const adminKey = params.adminKey || bodyData.adminKey;
  if (!adminKey) return json(401, { error: 'Invalid admin key' });

  const room = await getRoomByAdminKeyHash(db, hashAdminKey(adminKey));
  if (!room) return json(401, { error: 'Invalid admin key' });

  if (event.httpMethod === 'GET') {
    const result = await db.execute({
      sql: 'SELECT * FROM questions WHERE room_code = ? ORDER BY order_index ASC',
      args: [room.room_code],
    });
    return json(200, { questions: result.rows });
  }

  if (event.httpMethod === 'POST') {
    const { type, prompt, options, scaleMin, scaleMax } = bodyData;
    const orderResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(order_index), -1) + 1 AS nextIndex FROM questions WHERE room_code = ?',
      args: [room.room_code],
    });
    const orderIndex = orderResult.rows[0].nextIndex;
    const insertResult = await db.execute({
      sql: `INSERT INTO questions (room_code, order_index, type, prompt, options, scale_min, scale_max, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        room.room_code,
        orderIndex,
        type,
        prompt,
        type === 'choice' ? JSON.stringify(options) : null,
        type === 'rating' ? (scaleMin ?? 1) : null,
        type === 'rating' ? (scaleMax ?? 5) : null,
        Date.now(),
      ],
    });
    return json(200, { id: Number(insertResult.lastInsertRowid), orderIndex });
  }

  if (event.httpMethod === 'PATCH') {
    const { questionId, action } = bodyData;

    if (action === 'reset') {
      await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
      const questionResult = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [questionId] });
      const question = questionResult.rows[0];
      const tally = computeTally(question, []);
      await publishEvent(room.room_code, 'tally', { questionId, ...tally });
      await publishEvent(room.room_code, 'reset', { questionId });
      return json(200, { ok: true });
    }

    const fields = [];
    const args = [];
    for (const [col, key] of [
      ['prompt', 'prompt'],
      ['options', 'options'],
      ['scale_min', 'scaleMin'],
      ['scale_max', 'scaleMax'],
      ['order_index', 'orderIndex'],
      ['type', 'type'],
    ]) {
      if (bodyData[key] !== undefined) {
        fields.push(`${col} = ?`);
        args.push(col === 'options' ? JSON.stringify(bodyData[key]) : bodyData[key]);
      }
    }
    if (fields.length === 0) return json(400, { error: 'No fields to update' });
    args.push(questionId);
    await db.execute({ sql: `UPDATE questions SET ${fields.join(', ')} WHERE id = ?`, args });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const { questionId } = bodyData;
    await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
    await db.execute({ sql: 'DELETE FROM questions WHERE id = ?', args: [questionId] });
    if (Number(room.current_question_id) === Number(questionId)) {
      await db.execute({ sql: 'UPDATE rooms SET current_question_id = NULL WHERE room_code = ?', args: [room.room_code] });
      await publishEvent(room.room_code, 'state', { status: room.status, currentQuestion: null, initialTally: null });
    }
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
