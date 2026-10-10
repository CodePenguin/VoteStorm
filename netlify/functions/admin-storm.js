import { createDb, initSchema, touchStormActivity, deleteStormCascade, deleteVotesForStorm, connectVisible, resultsBackground } from '../../lib/db.js';
import { normalizeHexColor } from '../../lib/color.js';
import { verifyAdmin } from '../../lib/adminAuth.js';
import { MAX_NAME_LENGTH, normalizeStormName } from '../../lib/storms.js';
import { applyPresentedLicense, describeLicense } from '../../lib/license.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { shapeCloud, publicTally, votingMsLeft, MAX_VOTING_SECONDS } from '../../lib/cloud.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  const db = createDb();
  await initSchema(db);

  const auth = await verifyAdmin(event, db, 'admin-storm');
  if (auth.response) return auth.response;
  const { storm } = auth;

  let bodyData;
  try {
    bodyData = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const license = await applyPresentedLicense(db, storm, event);

  if (event.httpMethod === 'GET') {
    const cloudsResult = await db.execute({
      sql: 'SELECT * FROM clouds WHERE storm_code = ? ORDER BY order_index ASC',
      args: [storm.storm_code],
    });
    const clouds = [];
    for (const cloud of cloudsResult.rows) {
      const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [cloud.id] });
      clouds.push({ ...cloud, voting_ms_left: votingMsLeft(cloud), tally: computeTally(cloud, votesResult.rows) });
    }
    return json(200, { storm, clouds, showConnect: connectVisible(storm), resultsBackground: resultsBackground(storm), license: describeLicense(license) });
  }

  if (event.httpMethod === 'PATCH') {
    await touchStormActivity(db, storm.storm_code);

    if (bodyData.action === 'reset') {
      await deleteVotesForStorm(db, storm.storm_code);
      if (storm.current_cloud_id) {
        const cloudResult = await db.execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [storm.current_cloud_id] });
        const cloud = cloudResult.rows[0];
        if (cloud) {
          await publishEvent(storm.storm_code, 'tally', { cloudId: cloud.id, ...computeTally(cloud, []) });
        }
      }
      await publishEvent(storm.storm_code, 'reset', {});
      return json(200, { ok: true });
    }

    if (bodyData.currentCloudId) {
      // Deviation from brief: scope the lookup by storm_code as well as id to
      // prevent cross-storm IDOR (an admin pointing their storm's current
      // cloud at another storm's cloud id, which would leak that
      // cloud's text/options to their own storm via the 'state' event).
      const cloudResult = await db.execute({
        sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
        args: [bodyData.currentCloudId, storm.storm_code],
      });
      if (!cloudResult.rows[0]) {
        return json(400, { error: 'Invalid cloudId' });
      }
    }

    // A colour is `#rrggbb` or null/'' (back to the default theme); anything else is refused before anything is written.
    let newBackground;
    if (bodyData.resultsBackground !== undefined) {
      const wanted = bodyData.resultsBackground;
      newBackground = wanted === null || wanted === '' ? null : normalizeHexColor(wanted);
      if (newBackground === undefined) return json(400, { error: 'resultsBackground must be a colour like #1e293b' });
    }

    // A name is text up to MAX_NAME_LENGTH, or null/'' to clear it; anything else is refused before anything is written.
    let newName;
    if (bodyData.name !== undefined) {
      newName = normalizeStormName(bodyData.name);
      if (newName === undefined) return json(400, { error: `The name must be text of at most ${MAX_NAME_LENGTH} characters` });
    }

    // Voting lock / timer for a cloud: exactly one of votingLocked, votingSeconds, votingAddSeconds.
    let newClosesAt;
    const votingKeys = ['votingLocked', 'votingSeconds', 'votingAddSeconds'].filter((k) => bodyData[k] !== undefined);
    if (votingKeys.length > 1) return json(400, { error: 'Send one voting change at a time' });
    if (votingKeys.length === 1) {
      const targetId = bodyData.cloudId ?? storm.current_cloud_id;
      const target = targetId
        ? (await db.execute({ sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?', args: [targetId, storm.storm_code] })).rows[0]
        : null;
      if (!target) return json(400, { error: 'There is no cloud to lock or time' });
      const now = Date.now();
      const seconds = bodyData.votingSeconds ?? bodyData.votingAddSeconds;
      if (votingKeys[0] !== 'votingLocked' && !(Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_VOTING_SECONDS)) {
        return json(400, { error: `Seconds must be a whole number from 1 to ${MAX_VOTING_SECONDS}` });
      }
      if (votingKeys[0] === 'votingLocked') newClosesAt = bodyData.votingLocked ? now : null;
      else if (votingKeys[0] === 'votingSeconds') newClosesAt = now + seconds * 1000;
      else newClosesAt = Math.max(now, Number(target.closes_at) || 0) + seconds * 1000;
      await db.execute({ sql: 'UPDATE clouds SET closes_at = ? WHERE id = ? AND storm_code = ?', args: [newClosesAt, target.id, storm.storm_code] });
    }

    const flagTargetId = bodyData.cloudId ?? storm.current_cloud_id;
    if ((bodyData.resultsHidden !== undefined || bodyData.answerShown !== undefined) && flagTargetId) {
      const sets = [];
      const qargs = [];
      if (bodyData.resultsHidden !== undefined) { sets.push('results_hidden = ?'); qargs.push(bodyData.resultsHidden ? 1 : 0); }
      if (bodyData.answerShown !== undefined) { sets.push('answer_shown = ?'); qargs.push(bodyData.answerShown ? 1 : 0); }
      qargs.push(flagTargetId, storm.storm_code);
      await db.execute({ sql: `UPDATE clouds SET ${sets.join(', ')} WHERE id = ? AND storm_code = ?`, args: qargs });
    }

    const fields = [];
    const args = [];
    if (bodyData.status !== undefined) {
      fields.push('status = ?');
      args.push(bodyData.status);
    }
    if (bodyData.currentCloudId !== undefined) {
      fields.push('current_cloud_id = ?');
      args.push(bodyData.currentCloudId);
      // A cloud that comes live starts open, whatever lock or timer it had before.
      if (Number(bodyData.currentCloudId) !== Number(storm.current_cloud_id)) {
        await db.execute({ sql: 'UPDATE clouds SET closes_at = NULL WHERE id = ? AND storm_code = ?', args: [bodyData.currentCloudId, storm.storm_code] });
      }
    }
    if (bodyData.showConnect !== undefined) {
      fields.push('show_connect = ?');
      args.push(bodyData.showConnect ? 1 : 0);
    } else if (bodyData.currentCloudId !== undefined || bodyData.status !== undefined) {
      fields.push('show_connect = NULL');
    }
    if (newBackground !== undefined) {
      fields.push('results_background = ?');
      args.push(newBackground);
    }
    if (newName !== undefined) {
      fields.push('name = ?');
      args.push(newName);
    }
    if (fields.length > 0) {
      args.push(storm.storm_code);
      await db.execute({ sql: `UPDATE storms SET ${fields.join(', ')} WHERE storm_code = ?`, args });
    }

    if (bodyData.currentCloudId !== undefined || bodyData.status !== undefined || bodyData.showConnect !== undefined || newBackground !== undefined || votingKeys.length > 0 || bodyData.resultsHidden !== undefined || bodyData.answerShown !== undefined) {
      // When only `status` changes (e.g. closing the storm), currentCloudId
      // wasn't provided in the body, so re-derive it from the storm's existing
      // current_cloud_id so clients still get a complete picture.
      const effectiveCloudId =
        bodyData.currentCloudId !== undefined ? bodyData.currentCloudId : storm.current_cloud_id;

      let currentCloud = null;
      let initialTally = null;
      if (effectiveCloudId) {
        const cloudResult = await db.execute({
          sql: 'SELECT * FROM clouds WHERE id = ? AND storm_code = ?',
          args: [effectiveCloudId, storm.storm_code],
        });
        currentCloud = cloudResult.rows[0] || null;
        if (currentCloud) {
          const votesResult = await db.execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [currentCloud.id] });
          initialTally = computeTally(currentCloud, votesResult.rows);
        }
      }
      const effectiveStatus = bodyData.status ?? storm.status;
      const reveal = effectiveStatus === 'closed';
      const shapedCurrentCloud = currentCloud ? shapeCloud(currentCloud, { reveal }) : null;
      if (currentCloud) initialTally = publicTally(currentCloud, initialTally, { reveal });

      await publishEvent(storm.storm_code, 'state', {
        status: bodyData.status ?? storm.status,
        currentCloud: shapedCurrentCloud,
        initialTally,
        showConnect: bodyData.showConnect !== undefined
          ? !!bodyData.showConnect
          : connectVisible({ show_connect: null }, bodyData.status ?? storm.status, effectiveCloudId),
        resultsBackground: newBackground !== undefined ? newBackground : resultsBackground(storm),
      });
    }

    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    await deleteStormCascade(db, storm.storm_code);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
