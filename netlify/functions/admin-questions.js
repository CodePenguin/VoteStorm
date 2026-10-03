import { createDb, initSchema, getRoomByAdminKeyHash, touchRoomActivity, connectVisible } from '../../lib/db.js';
import { hashAdminKey } from '../../lib/roomCode.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { applyPresentedLicense } from '../../lib/license.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  const db = createDb();
  await initSchema(db);

  const params = event.queryStringParameters || {};
  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const adminKey = params.adminKey || bodyData.adminKey;
  if (!adminKey) return json(401, { error: 'Invalid admin key' });

  const room = await getRoomByAdminKeyHash(db, hashAdminKey(adminKey));
  if (!room) return json(401, { error: 'Invalid admin key' });

  const license = await applyPresentedLicense(db, room, event);
  if (event.httpMethod !== 'GET') {
    await touchRoomActivity(db, room.room_code);
  }

  if (event.httpMethod === 'GET') {
    const result = await db.execute({
      sql: 'SELECT * FROM questions WHERE room_code = ? ORDER BY order_index ASC',
      args: [room.room_code],
    });
    return json(200, { questions: result.rows });
  }

  if (event.httpMethod === 'POST') {
    const { type, prompt, options, scaleMin, scaleMax, multi, resultsHidden, correct, display } = bodyData;
    if (license.maxQuestionsPerRoom) {
      const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM questions WHERE room_code = ?', args: [room.room_code] });
      if (Number(count.rows[0].n) >= license.maxQuestionsPerRoom) {
        return json(403, {
          error: `This room has reached its limit of ${license.maxQuestionsPerRoom} question${license.maxQuestionsPerRoom === 1 ? '' : 's'}.`,
          code: 'question_limit',
        });
      }
    }
    const orderResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(order_index), -1) + 1 AS nextIndex FROM questions WHERE room_code = ?',
      args: [room.room_code],
    });
    const orderIndex = orderResult.rows[0].nextIndex;
    const insertResult = await db.execute({
      sql: `INSERT INTO questions (room_code, order_index, type, prompt, options, scale_min, scale_max, multi, results_hidden, correct, display, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        room.room_code,
        orderIndex,
        type,
        prompt,
        type === 'choice' ? JSON.stringify(options) : null,
        type === 'rating' ? (scaleMin ?? 1) : null,
        type === 'rating' ? (scaleMax ?? 5) : null,
        type === 'choice' && multi ? 1 : 0,
        resultsHidden ? 1 : 0,
        type === 'choice' && Array.isArray(correct) && correct.length ? JSON.stringify([...new Set(correct.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < (options || []).length))].sort((a, b) => a - b)) : null,
        type === 'choice' && display === 'donut' ? 'donut' : 'bars',
        Date.now(),
      ],
    });
    return json(200, { id: Number(insertResult.lastInsertRowid), orderIndex });
  }

  if (event.httpMethod === 'PATCH') {
    const { questionId, action } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
      args: [questionId, room.room_code],
    });
    const question = ownedResult.rows[0];
    if (!question) return json(404, { error: 'Question not found' });

    if (action === 'reset') {
      await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
      const tally = computeTally(question, []);
      await publishEvent(room.room_code, 'tally', { questionId, ...tally });
      await publishEvent(room.room_code, 'reset', { questionId });
      return json(200, { ok: true });
    }

    if (bodyData.edit) {
      const e = bodyData.edit;
      const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
      if (!prompt) return json(400, { error: 'A prompt is required' });
      if (e.type !== 'choice' && e.type !== 'rating') return json(400, { error: 'Invalid question type' });

      let options = null;
      let scaleMin = null;
      let scaleMax = null;
      let multi = 0;
      let correct = null;
      let display = 'bars';
      if (e.type === 'choice') {
        options = Array.isArray(e.options) ? e.options.map((o) => String(o).trim()).filter(Boolean) : [];
        if (options.length < 2) return json(400, { error: 'At least two options are required' });
        multi = e.multi ? 1 : 0;
        display = e.display === 'donut' ? 'donut' : 'bars';
        const picked = Array.isArray(e.correct) ? e.correct.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length) : [];
        correct = picked.length ? JSON.stringify([...new Set(picked)].sort((a, b) => a - b)) : null;
      } else {
        scaleMin = Number.isInteger(e.scaleMin) ? e.scaleMin : 1;
        scaleMax = Number.isInteger(e.scaleMax) ? e.scaleMax : 5;
        if (scaleMin >= scaleMax) return json(400, { error: 'Scale max must be greater than min' });
      }

      // Votes only keep their meaning when the shape of the question is unchanged.
      const oldOptions = question.options ? JSON.parse(question.options) : null;
      const structural = e.type !== question.type
        || (e.type === 'choice'
          ? !!question.multi !== !!multi || (oldOptions ? oldOptions.length : 0) !== options.length
          : Number(question.scale_min) !== scaleMin || Number(question.scale_max) !== scaleMax);
      const countResult = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM votes WHERE question_id = ?', args: [questionId] });
      const voteCount = Number(countResult.rows[0].n);
      const clearing = structural && voteCount > 0;
      if (clearing && !e.clearVotes) {
        return json(409, {
          error: `Saving these changes will clear ${voteCount} vote${voteCount === 1 ? '' : 's'} on this question.`,
          code: 'needs_clear',
          votes: voteCount,
        });
      }

      await db.execute({
        sql: `UPDATE questions SET type = ?, prompt = ?, options = ?, scale_min = ?, scale_max = ?, multi = ?, correct = ?, display = ?,
              results_hidden = ?, answer_shown = CASE WHEN ? IS NULL THEN 0 ELSE answer_shown END WHERE id = ? AND room_code = ?`,
        args: [e.type, prompt, options ? JSON.stringify(options) : null, scaleMin, scaleMax, multi, correct, display, e.resultsHidden ? 1 : 0, correct, questionId, room.room_code],
      });
      if (clearing) await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });

      const updated = (await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [questionId] })).rows[0];
      const updatedVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [questionId] })).rows;
      const reveal = room.status === 'closed';
      const updatedTally = publicTally(updated, computeTally(updated, updatedVotes), { reveal });

      let current = null;
      let currentTally = null;
      if (room.current_question_id) {
        const currentRow = (await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [room.current_question_id] })).rows[0];
        if (currentRow) {
          const currentVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [currentRow.id] })).rows;
          current = shapeQuestion(currentRow, { reveal });
          currentTally = publicTally(currentRow, computeTally(currentRow, currentVotes), { reveal });
        }
      }
      await publishEvent(room.room_code, 'state', {
        status: room.status,
        currentQuestion: current,
        initialTally: currentTally,
        showConnect: connectVisible(room),
      });
      if (clearing) {
        await publishEvent(room.room_code, 'tally', { questionId, ...updatedTally });
        await publishEvent(room.room_code, 'reset', { questionId });
      }
      return json(200, { ok: true, cleared: clearing ? voteCount : 0 });
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
    args.push(questionId, room.room_code);
    await db.execute({ sql: `UPDATE questions SET ${fields.join(', ')} WHERE id = ? AND room_code = ?`, args });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const { questionId } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
      args: [questionId, room.room_code],
    });
    if (!ownedResult.rows[0]) return json(404, { error: 'Question not found' });

    await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
    await db.execute({ sql: 'DELETE FROM questions WHERE id = ? AND room_code = ?', args: [questionId, room.room_code] });
    if (Number(room.current_question_id) === Number(questionId)) {
      await db.execute({ sql: 'UPDATE rooms SET current_question_id = NULL WHERE room_code = ?', args: [room.room_code] });
      await publishEvent(room.room_code, 'state', { status: room.status, currentQuestion: null, initialTally: null });
    }
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
