import { createDb, initSchema, getStormByAdminKeyHash, touchStormActivity, connectVisible } from '../../lib/db.js';
import { hashAdminKey } from '../../lib/stormCode.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { shapeQuestion, publicTally } from '../../lib/question.js';
import { applyPresentedLicense } from '../../lib/license.js';
import { normalizeQuestionInput } from '../../lib/questionInput.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
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

  const storm = await getStormByAdminKeyHash(db, hashAdminKey(adminKey));
  if (!storm) return json(401, { error: 'Invalid admin key' });

  const license = await applyPresentedLicense(db, storm, event);
  if (event.httpMethod !== 'GET') {
    await touchStormActivity(db, storm.storm_code);
  }

  if (event.httpMethod === 'GET') {
    const result = await db.execute({
      sql: 'SELECT * FROM questions WHERE storm_code = ? ORDER BY order_index ASC',
      args: [storm.storm_code],
    });
    return json(200, { questions: result.rows });
  }

  if (event.httpMethod === 'POST') {
    const limited = await rateLimitByIp(db, event, 'addQuestion');
    if (limited) return limited;
    const parsed = normalizeQuestionInput(bodyData);
    if (parsed.error) return json(400, { error: parsed.error });
    const q = parsed.value;
    if (license.maxQuestionsPerStorm) {
      const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM questions WHERE storm_code = ?', args: [storm.storm_code] });
      if (Number(count.rows[0].n) >= license.maxQuestionsPerStorm) {
        return json(403, {
          error: `This Storm has reached its limit of ${license.maxQuestionsPerStorm} question${license.maxQuestionsPerStorm === 1 ? '' : 's'}.`,
          code: 'question_limit',
        });
      }
    }
    const orderResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(order_index), -1) + 1 AS nextIndex FROM questions WHERE storm_code = ?',
      args: [storm.storm_code],
    });
    const orderIndex = orderResult.rows[0].nextIndex;
    const insertResult = await db.execute({
      sql: `INSERT INTO questions (storm_code, order_index, type, prompt, options, scale_min, scale_max, multi, results_hidden, correct, display, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        storm.storm_code,
        orderIndex,
        q.type,
        q.prompt,
        q.options ? JSON.stringify(q.options) : null,
        q.scaleMin,
        q.scaleMax,
        q.multi,
        q.resultsHidden,
        q.correct,
        q.display,
        Date.now(),
      ],
    });
    return json(200, { id: Number(insertResult.lastInsertRowid), orderIndex });
  }

  if (event.httpMethod === 'PATCH') {
    const { questionId, action } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM questions WHERE id = ? AND storm_code = ?',
      args: [questionId, storm.storm_code],
    });
    const question = ownedResult.rows[0];
    if (!question) return json(404, { error: 'Question not found' });

    if (action === 'reset') {
      await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
      const tally = computeTally(question, []);
      await publishEvent(storm.storm_code, 'tally', { questionId, ...tally });
      await publishEvent(storm.storm_code, 'reset', { questionId });
      return json(200, { ok: true });
    }

    if (bodyData.edit) {
      const e = bodyData.edit;
      const parsed = normalizeQuestionInput(e);
      if (parsed.error) return json(400, { error: parsed.error });
      const { prompt, options, scaleMin, scaleMax, multi, correct, display } = parsed.value;

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
              results_hidden = ?, answer_shown = CASE WHEN ? IS NULL THEN 0 ELSE answer_shown END WHERE id = ? AND storm_code = ?`,
        args: [e.type, prompt, options ? JSON.stringify(options) : null, scaleMin, scaleMax, multi, correct, display, parsed.value.resultsHidden, correct, questionId, storm.storm_code],
      });
      if (clearing) await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });

      const updated = (await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [questionId] })).rows[0];
      const updatedVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [questionId] })).rows;
      const reveal = storm.status === 'closed';
      const updatedTally = publicTally(updated, computeTally(updated, updatedVotes), { reveal });

      let current = null;
      let currentTally = null;
      if (storm.current_question_id) {
        const currentRow = (await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [storm.current_question_id] })).rows[0];
        if (currentRow) {
          const currentVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE question_id = ?', args: [currentRow.id] })).rows;
          current = shapeQuestion(currentRow, { reveal });
          currentTally = publicTally(currentRow, computeTally(currentRow, currentVotes), { reveal });
        }
      }
      await publishEvent(storm.storm_code, 'state', {
        status: storm.status,
        currentQuestion: current,
        initialTally: currentTally,
        showConnect: connectVisible(storm),
      });
      if (clearing) {
        await publishEvent(storm.storm_code, 'tally', { questionId, ...updatedTally });
        await publishEvent(storm.storm_code, 'reset', { questionId });
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
    args.push(questionId, storm.storm_code);
    await db.execute({ sql: `UPDATE questions SET ${fields.join(', ')} WHERE id = ? AND storm_code = ?`, args });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const { questionId } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM questions WHERE id = ? AND storm_code = ?',
      args: [questionId, storm.storm_code],
    });
    if (!ownedResult.rows[0]) return json(404, { error: 'Question not found' });

    await db.execute({ sql: 'DELETE FROM votes WHERE question_id = ?', args: [questionId] });
    await db.execute({ sql: 'DELETE FROM questions WHERE id = ? AND storm_code = ?', args: [questionId, storm.storm_code] });
    if (Number(storm.current_question_id) === Number(questionId)) {
      await db.execute({ sql: 'UPDATE storms SET current_question_id = NULL WHERE storm_code = ?', args: [storm.storm_code] });
      await publishEvent(storm.storm_code, 'state', { status: storm.status, currentQuestion: null, initialTally: null });
    }
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
