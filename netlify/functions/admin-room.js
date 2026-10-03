import { createDb, initSchema, getRoomByAdminKeyHash, touchRoomActivity, deleteRoomCascade, connectVisible } from '../../lib/db.js';
import { hashAdminKey, deriveResultsKey, hashResultsKey } from '../../lib/roomCode.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
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

  if (event.httpMethod === 'GET') {
    const questionsResult = await db.execute({
      sql: 'SELECT * FROM questions WHERE room_code = ? ORDER BY order_index ASC',
      args: [room.room_code],
    });
    const questions = [];
    for (const question of questionsResult.rows) {
      const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [question.id] });
      questions.push({ ...question, tally: computeTally(question, votesResult.rows) });
    }
    const resultsKey = deriveResultsKey(adminKey);
    const resultsKeyHash = hashResultsKey(resultsKey);
    if (room.results_key_hash !== resultsKeyHash) {
      await db.execute({ sql: 'UPDATE rooms SET results_key_hash = ? WHERE room_code = ?', args: [resultsKeyHash, room.room_code] });
    }
    return json(200, { room, questions, showConnect: connectVisible(room), resultsKey });
  }

  if (event.httpMethod === 'PATCH') {
    await touchRoomActivity(db, room.room_code);

    if (bodyData.action === 'reset') {
      const questionsResult = await db.execute({ sql: 'SELECT id FROM questions WHERE room_code = ?', args: [room.room_code] });
      for (const q of questionsResult.rows) {
        await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [q.id] });
      }
      if (room.current_question_id) {
        const questionResult = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [room.current_question_id] });
        const question = questionResult.rows[0];
        if (question) {
          await publishEvent(room.room_code, 'tally', { questionId: question.id, ...computeTally(question, []) });
        }
      }
      await publishEvent(room.room_code, 'reset', {});
      return json(200, { ok: true });
    }

    if (bodyData.currentQuestionId) {
      // Deviation from brief: scope the lookup by room_code as well as id to
      // prevent cross-room IDOR (an admin pointing their room's current
      // question at another room's question id, which would leak that
      // question's text/options to their own room via the 'state' event).
      const questionResult = await db.execute({
        sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
        args: [bodyData.currentQuestionId, room.room_code],
      });
      if (!questionResult.rows[0]) {
        return json(400, { error: 'Invalid questionId' });
      }
    }

    const flagTargetId = bodyData.questionId ?? room.current_question_id;
    if ((bodyData.resultsHidden !== undefined || bodyData.answerShown !== undefined) && flagTargetId) {
      const sets = [];
      const qargs = [];
      if (bodyData.resultsHidden !== undefined) { sets.push('results_hidden = ?'); qargs.push(bodyData.resultsHidden ? 1 : 0); }
      if (bodyData.answerShown !== undefined) { sets.push('answer_shown = ?'); qargs.push(bodyData.answerShown ? 1 : 0); }
      qargs.push(flagTargetId, room.room_code);
      await db.execute({ sql: `UPDATE questions SET ${sets.join(', ')} WHERE id = ? AND room_code = ?`, args: qargs });
    }

    const fields = [];
    const args = [];
    if (bodyData.status !== undefined) {
      fields.push('status = ?');
      args.push(bodyData.status);
    }
    if (bodyData.currentQuestionId !== undefined) {
      fields.push('current_question_id = ?');
      args.push(bodyData.currentQuestionId);
    }
    if (bodyData.showConnect !== undefined) {
      fields.push('show_connect = ?');
      args.push(bodyData.showConnect ? 1 : 0);
    } else if (bodyData.currentQuestionId !== undefined || bodyData.status !== undefined) {
      fields.push('show_connect = NULL');
    }
    if (fields.length > 0) {
      args.push(room.room_code);
      await db.execute({ sql: `UPDATE rooms SET ${fields.join(', ')} WHERE room_code = ?`, args });
    }

    if (bodyData.currentQuestionId !== undefined || bodyData.status !== undefined || bodyData.showConnect !== undefined || bodyData.resultsHidden !== undefined || bodyData.answerShown !== undefined) {
      // When only `status` changes (e.g. closing the room), currentQuestionId
      // wasn't provided in the body, so re-derive it from the room's existing
      // current_question_id so clients still get a complete picture.
      const effectiveQuestionId =
        bodyData.currentQuestionId !== undefined ? bodyData.currentQuestionId : room.current_question_id;

      let currentQuestion = null;
      let initialTally = null;
      if (effectiveQuestionId) {
        const questionResult = await db.execute({
          sql: 'SELECT * FROM questions WHERE id = ? AND room_code = ?',
          args: [effectiveQuestionId, room.room_code],
        });
        currentQuestion = questionResult.rows[0] || null;
        if (currentQuestion) {
          const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [currentQuestion.id] });
          initialTally = computeTally(currentQuestion, votesResult.rows);
        }
      }
      const effectiveStatus = bodyData.status ?? room.status;
      const reveal = effectiveStatus === 'closed';
      const shapedCurrentQuestion = currentQuestion ? shapeQuestion(currentQuestion, { reveal }) : null;
      if (currentQuestion) initialTally = publicTally(currentQuestion, initialTally, { reveal });

      await publishEvent(room.room_code, 'state', {
        status: bodyData.status ?? room.status,
        currentQuestion: shapedCurrentQuestion,
        initialTally,
        showConnect: bodyData.showConnect !== undefined
          ? !!bodyData.showConnect
          : connectVisible({ show_connect: null }, bodyData.status ?? room.status, effectiveQuestionId),
      });
    }

    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    await deleteRoomCascade(db, room.room_code);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
