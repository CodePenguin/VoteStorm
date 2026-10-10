import { createDb, initSchema, touchStormActivity, connectVisible, resultsBackground } from '../../lib/db.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { shapeCloud, publicTally } from '../../lib/cloud.js';
import { applyPresentedLicense } from '../../lib/license.js';
import { verifyAdmin } from '../../lib/adminAuth.js';
import { normalizeCloudInput } from '../../lib/cloudInput.js';
import { cleanWord, parseHiddenWords } from '../../lib/words.js';
import { rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  const db = createDb();
  await initSchema(db);

  const auth = await verifyAdmin(event, db, 'admin-clouds');
  if (auth.response) return auth.response;
  const { storm } = auth;

  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const license = await applyPresentedLicense(db, storm, event);
  if (event.httpMethod !== 'GET') {
    await touchStormActivity(db, storm.storm_code);
  }

  if (event.httpMethod === 'GET') {
    const result = await db.execute({
      sql: 'SELECT * FROM clouds WHERE storm_code = ? ORDER BY order_index ASC',
      args: [storm.storm_code],
    });
    return json(200, { clouds: result.rows });
  }

  if (event.httpMethod === 'POST') {
    const limited = await rateLimitByIp(db, event, 'addCloud');
    if (limited) return limited;
    const parsed = normalizeCloudInput(bodyData);
    if (parsed.error) return json(400, { error: parsed.error });
    const q = parsed.value;
    if (license.maxQuestionsPerStorm) {
      const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM clouds WHERE storm_code = ?', args: [storm.storm_code] });
      if (Number(count.rows[0].n) >= license.maxQuestionsPerStorm) {
        return json(403, {
          error: `This Storm has reached its limit of ${license.maxQuestionsPerStorm} cloud${license.maxQuestionsPerStorm === 1 ? '' : 's'}.`,
          code: 'cloud_limit',
        });
      }
    }
    const orderResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(order_index), -1) + 1 AS nextIndex FROM clouds WHERE storm_code = ?',
      args: [storm.storm_code],
    });
    const orderIndex = orderResult.rows[0].nextIndex;
    const insertResult = await db.execute({
      sql: `INSERT INTO clouds (storm_code, order_index, kind, body, options, scale_min, scale_max, multi, results_hidden, correct, display, max_words, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        storm.storm_code,
        orderIndex,
        q.kind,
        q.body,
        q.options ? JSON.stringify(q.options) : null,
        q.scaleMin,
        q.scaleMax,
        q.multi,
        q.resultsHidden,
        q.correct,
        q.display,
        q.maxWords,
        Date.now(),
      ],
    });
    return json(200, { id: Number(insertResult.lastInsertRowid), orderIndex });
  }

  if (event.httpMethod === 'PATCH') {
    const { cloudId, action } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
      args: [cloudId, storm.storm_code],
    });
    const cloud = ownedResult.rows[0];
    if (!cloud) return json(404, { error: 'Cloud not found' });
    // Events carry the stored id, never the raw request value (a string id would not match on the clients).
    const id = Number(cloud.id);

    if (bodyData.hideWord !== undefined || bodyData.showWord !== undefined) {
      if (cloud.kind !== 'words') return json(400, { error: 'Only a word cloud has words to remove' });
      const word = cleanWord(bodyData.hideWord !== undefined ? bodyData.hideWord : bodyData.showWord);
      if (!word) return json(400, { error: 'Send the word to remove or restore' });
      const hidden = new Set(parseHiddenWords(cloud));
      if (bodyData.hideWord !== undefined) hidden.add(word);
      else hidden.delete(word);
      await db.execute({ sql: 'UPDATE clouds SET hidden_words = ? WHERE id = ? AND storm_code = ?', args: [JSON.stringify([...hidden]), cloudId, storm.storm_code] });
      const votes = (await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [cloudId] })).rows;
      const fresh = { ...cloud, hidden_words: JSON.stringify([...hidden]) };
      await publishEvent(storm.storm_code, 'tally', { cloudId: id, ...publicTally(fresh, computeTally(fresh, votes), { reveal: storm.status === 'closed' }) });
      return json(200, { ok: true });
    }

    if (action === 'reset') {
      await db.execute({ sql: 'DELETE FROM votes WHERE cloud_id = ?', args: [cloudId] });
      const tally = computeTally(cloud, []);
      await publishEvent(storm.storm_code, 'tally', { cloudId: id, ...tally });
      await publishEvent(storm.storm_code, 'reset', { cloudId: id });
      return json(200, { ok: true });
    }

    if (bodyData.edit) {
      const e = bodyData.edit;
      const parsed = normalizeCloudInput(e);
      if (parsed.error) return json(400, { error: parsed.error });
      const { body, options, scaleMin, scaleMax, multi, correct, display, maxWords } = parsed.value;

      // Votes only keep their meaning when the shape of the cloud is unchanged.
      const oldOptions = cloud.options ? JSON.parse(cloud.options) : null;
      const structural = e.kind !== cloud.kind
        || (e.kind === 'choice'
          ? !!cloud.multi !== !!multi || (oldOptions ? oldOptions.length : 0) !== options.length
          : e.kind === 'rating'
            ? Number(cloud.scale_min) !== scaleMin || Number(cloud.scale_max) !== scaleMax
            : false);
      const countResult = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM votes WHERE cloud_id = ?', args: [cloudId] });
      const voteCount = Number(countResult.rows[0].n);
      const clearing = structural && voteCount > 0;
      if (clearing && !e.clearVotes) {
        return json(409, {
          error: `Saving these changes will clear ${voteCount} vote${voteCount === 1 ? '' : 's'} on this cloud.`,
          code: 'needs_clear',
          votes: voteCount,
        });
      }

      // Removed words belong to the words the cloud had; a change of kind starts with none (SET reads the old kind).
      await db.execute({
        sql: `UPDATE clouds SET kind = ?, body = ?, options = ?, scale_min = ?, scale_max = ?, multi = ?, correct = ?, display = ?,
              results_hidden = ?, max_words = ?, answer_shown = CASE WHEN ? IS NULL THEN 0 ELSE answer_shown END,
              hidden_words = CASE WHEN kind <> ? THEN NULL ELSE hidden_words END WHERE id = ? AND storm_code = ?`,
        args: [e.kind, body, options ? JSON.stringify(options) : null, scaleMin, scaleMax, multi, correct, display, parsed.value.resultsHidden, maxWords, correct, e.kind, cloudId, storm.storm_code],
      });
      if (clearing) await db.execute({ sql: 'DELETE FROM votes WHERE cloud_id = ?', args: [cloudId] });

      const updated = (await db.execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [cloudId] })).rows[0];
      const updatedVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [cloudId] })).rows;
      const reveal = storm.status === 'closed';
      const updatedTally = publicTally(updated, computeTally(updated, updatedVotes), { reveal });

      let current = null;
      let currentTally = null;
      if (storm.current_cloud_id) {
        const currentRow = (await db.execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [storm.current_cloud_id] })).rows[0];
        if (currentRow) {
          const currentVotes = (await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [currentRow.id] })).rows;
          current = shapeCloud(currentRow, { reveal });
          currentTally = publicTally(currentRow, computeTally(currentRow, currentVotes), { reveal });
        }
      }
      await publishEvent(storm.storm_code, 'state', {
        status: storm.status,
        currentCloud: current,
        initialTally: currentTally,
        showConnect: connectVisible(storm),
        resultsBackground: resultsBackground(storm),
      });
      if (clearing) {
        await publishEvent(storm.storm_code, 'tally', { cloudId: id, ...updatedTally });
        await publishEvent(storm.storm_code, 'reset', { cloudId: id });
      }
      return json(200, { ok: true, cleared: clearing ? voteCount : 0 });
    }

    // Outside an edit (which validates everything through normalizeCloudInput) only the order can change.
    if (!Number.isInteger(bodyData.orderIndex)) return json(400, { error: 'No fields to update' });
    await db.execute({ sql: 'UPDATE clouds SET order_index = ? WHERE id = ? AND storm_code = ?', args: [bodyData.orderIndex, id, storm.storm_code] });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const { cloudId } = bodyData;

    const ownedResult = await db.execute({
      sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
      args: [cloudId, storm.storm_code],
    });
    if (!ownedResult.rows[0]) return json(404, { error: 'Cloud not found' });

    await db.execute({ sql: 'DELETE FROM votes WHERE cloud_id = ?', args: [cloudId] });
    await db.execute({ sql: 'DELETE FROM clouds WHERE id = ? AND storm_code = ?', args: [cloudId, storm.storm_code] });
    if (Number(storm.current_cloud_id) === Number(cloudId)) {
      await db.execute({ sql: 'UPDATE storms SET current_cloud_id = NULL WHERE storm_code = ?', args: [storm.storm_code] });
      await publishEvent(storm.storm_code, 'state', { status: storm.status, currentCloud: null, initialTally: null });
    }
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
