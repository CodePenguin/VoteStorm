import { createDb, initSchema, getStormByCode, touchStormActivity } from '../../lib/db.js';
import { stormLicense } from '../../lib/license.js';
import { computeTally } from '../../lib/tally.js';
import { publishEvent } from '../../lib/realtime.js';
import { publicTally, votingClosed } from '../../lib/cloud.js';
import { cleanWordList, DEFAULT_MAX_WORDS } from '../../lib/words.js';
import { rateLimit, rateLimitByIp } from '../../lib/rateLimit.js';
import { json } from '../../lib/http.js';

const MAX_BODY_BYTES = 8192;

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // The biggest legitimate vote is ten short words; anything this large is not one, and is refused before it is parsed.
  if ((event.body || '').length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const { stormCode, cloudId, deviceId, value } = body;
  if (!stormCode || !cloudId || !deviceId || value === undefined) {
    return json(400, { error: 'stormCode, cloudId, deviceId, value are required' });
  }

  if (typeof deviceId !== 'string' || !/^[\w-]{1,100}$/.test(deviceId)) {
    return json(400, { error: 'Invalid deviceId' });
  }

  const db = createDb();
  await initSchema(db);
  const limited = (await rateLimitByIp(db, event, 'voteByIp')) || (await rateLimit(db, 'voteByDevice', deviceId));
  if (limited) return limited;

  const storm = await getStormByCode(db, stormCode);
  if (!storm) return json(404, { error: 'Storm not found' });
  if (storm.status !== 'active' || Number(storm.current_cloud_id) !== Number(cloudId)) {
    return json(409, { error: 'This cloud is not currently active', code: 'not_active' });
  }

  const cloudResult = await db.execute({
    sql: 'SELECT * FROM clouds WHERE id = ?',
    args: [cloudId],
  });
  const cloud = cloudResult.rows[0];
  if (!cloud) return json(404, { error: 'Cloud not found' });
  if (votingClosed(cloud)) return json(409, { error: 'Voting has closed for this cloud.', code: 'voting_closed' });

  if (cloud.kind === 'content') return json(409, { error: 'This cloud takes no votes', code: 'no_votes' });

  const numericValue = Number(value);
  let storedValue = String(value);
  let sentWords = null;
  if (cloud.kind === 'choice' && cloud.multi) {
    const options = JSON.parse(cloud.options);
    const picks = Array.isArray(value) ? value.map(Number) : null;
    if (!picks || picks.length === 0 || !picks.every((n) => Number.isInteger(n) && n >= 0 && n < options.length)) {
      return json(400, { error: 'Invalid vote value' });
    }
    storedValue = JSON.stringify([...new Set(picks)].sort((a, b) => a - b));
  } else if (cloud.kind === 'choice') {
    const options = JSON.parse(cloud.options);
    if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue >= options.length) {
      return json(400, { error: 'Invalid vote value' });
    }
  } else if (cloud.kind === 'rating') {
    if (!Number.isInteger(numericValue) || numericValue < cloud.scale_min || numericValue > cloud.scale_max) {
      return json(400, { error: 'Invalid vote value' });
    }
  } else if (cloud.kind === 'words') {
    const cleaned = cleanWordList(value, Number(cloud.max_words) || DEFAULT_MAX_WORDS);
    if (cleaned.error) return json(400, { error: cleaned.error });
    storedValue = JSON.stringify(cleaned.words);
    sentWords = cleaned.words;
  }

  const { maxAudiencePerStorm } = stormLicense(storm);
  if (maxAudiencePerStorm) {
    const audience = await db.execute({
      sql: `SELECT COUNT(DISTINCT v.device_id) AS n, MAX(v.device_id = ?) AS mine
            FROM votes v JOIN clouds q ON q.id = v.cloud_id WHERE q.storm_code = ?`,
      args: [deviceId, storm.storm_code],
    });
    const { n, mine } = audience.rows[0];
    if (!Number(mine) && Number(n) >= maxAudiencePerStorm) {
      return json(403, { error: 'This Storm has reached its audience limit.', code: 'audience_full' });
    }
  }

  // A device may change its answer while the cloud is live: one row per device, replaced on resubmit.
  await db.execute({
    sql: `INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(cloud_id, device_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    args: [cloudId, deviceId, storedValue, Date.now()],
  });

  await touchStormActivity(db, storm.storm_code);
  const votesResult = await db.execute({
    sql: 'SELECT * FROM votes WHERE cloud_id = ?',
    args: [cloudId],
  });
  const tally = computeTally(cloud, votesResult.rows);

  const shown = publicTally(cloud, tally);
  await publishEvent(storm.storm_code, 'tally', { cloudId: Number(cloud.id), ...shown });

  return json(200, { ok: true, tally: shown, ...(sentWords ? { words: sentWords } : {}) });
}
