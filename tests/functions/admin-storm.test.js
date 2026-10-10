import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { publishEvent } from '../../lib/realtime.js';
import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler as cloudsHandler } from '../../netlify/functions/admin-clouds.js';
import { handler } from '../../netlify/functions/admin-storm.js';

describe('admin-storm function', () => {
  let admin, stormCode, cloudId;
  const call = (event) => admin.call(handler, 'admin-storm', event);
  const callClouds = (event) => admin.call(cloudsHandler, 'admin-clouds', event);

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
    stormCode = admin.stormCode;
    const createRes = await callClouds({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }) });
    cloudId = JSON.parse(createRes.body).id;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns storm detail with clouds and tallies', async () => {
    const res = await call({ httpMethod: 'GET' });
    const body = JSON.parse(res.body);
    expect(body.storm.storm_code).toBe(stormCode);
    expect(body.clouds).toHaveLength(1);
    expect(body.clouds[0].tally.totalVotes).toBe(0);
  });

  it('activates a cloud and publishes a state event', async () => {
    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ status: 'active' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentCloud must be shaped like get-storm-state.js's output, not the
    // raw DB row: options parsed into an array (not a JSON string), and
    // camelCase scale fields (not snake_case scale_min/scale_max).
    expect(Array.isArray(publishedPayload.currentCloud.options)).toBe(true);
    expect(publishedPayload.currentCloud.options).toEqual(['A', 'B']);
    expect(publishedPayload.currentCloud).not.toHaveProperty('scale_min');
    expect(publishedPayload.currentCloud).not.toHaveProperty('scale_max');
  });

  it('publishes camelCase scaleMin/scaleMax for a rating cloud', async () => {
    const createRes = await callClouds({ httpMethod: 'POST', body: JSON.stringify({ kind: 'rating', body: 'Rate it', scaleMin: 1, scaleMax: 10 }) });
    const ratingCloudId = JSON.parse(createRes.body).id;
    vi.clearAllMocks();

    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ currentCloudId: ratingCloudId }) });
    expect(res.statusCode).toBe(200);

    const publishedPayload = publishEvent.mock.calls[0][2];
    expect(publishedPayload.currentCloud.scaleMin).toBe(1);
    expect(publishedPayload.currentCloud.scaleMax).toBe(10);
    expect(publishedPayload.currentCloud).not.toHaveProperty('scale_min');
    expect(publishedPayload.currentCloud).not.toHaveProperty('scale_max');
    expect(publishedPayload.currentCloud.options).toBeNull();
  });

  it('bumps last_activity_at to now on PATCH (activate)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, stormCode] });

    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });

    const storm = await getStormByCode(db, stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on PATCH (reset action)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, stormCode] });

    await call({ httpMethod: 'PATCH', body: JSON.stringify({ action: 'reset' }) });

    const storm = await getStormByCode(db, stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('deletes the storm and its clouds', async () => {
    await call({ httpMethod: 'DELETE' });
    const res = await call({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects setting currentCloudId to a cloud belonging to another storm', async () => {
    const db = createDb();
    const other = await seedStorm(db);
    const otherCreateRes = await other.call(cloudsHandler, 'admin-clouds', {
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Other storm cloud', options: ['X', 'Y'] }),
    });
    const otherCloudId = JSON.parse(otherCreateRes.body).id;
    vi.clearAllMocks();

    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ currentCloudId: otherCloudId }) });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid cloudId' });
    expect(publishEvent).not.toHaveBeenCalled();

    const getRes = await call({ httpMethod: 'GET' });
    const body = JSON.parse(getRes.body);
    expect(body.storm.current_cloud_id).toBeNull();
  });

  it('publishes the real tally (not zeroed) when activating a cloud that already has votes', async () => {
    // Activate the cloud once, then record a vote directly against it,
    // then "re-activate" it (e.g. presenter clicking Activate again after a
    // partial reset). The republished state event must reflect the real
    // vote count, not an empty tally.
    const db = createDb();
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    await db.execute({
      sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [cloudId, 'dev-x', '0', Date.now()],
    });
    vi.clearAllMocks();

    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    expect(res.statusCode).toBe(200);

    const publishedPayload = publishEvent.mock.calls[0][2];
    expect(publishedPayload.initialTally.totalVotes).toBe(1);
    expect(publishedPayload.initialTally.counts).toEqual([1, 0]);
  });

  it('publishes a state event on a status-only change (closing the storm) with no currentCloudId in the body', async () => {
    // First activate a cloud so the storm has a current_cloud_id set.
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    vi.clearAllMocks();

    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ status: 'closed' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentCloud/initialTally should still be present, re-derived from
    // the storm's existing current_cloud_id, even though the PATCH body
    // didn't include currentCloudId.
    expect(publishedPayload.currentCloud).not.toBeNull();
    expect(publishedPayload.currentCloud.id).toBe(cloudId);
    expect(publishedPayload.initialTally).not.toBeNull();
  });

  it('showConnect defaults to visible in an empty lobby and is reported on GET', async () => {
    const res = await call({ httpMethod: 'GET' });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('presenter can show the join screen during a live cloud and it persists, publishing a state event', async () => {
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    let res = await call({ httpMethod: 'GET' });
    expect(JSON.parse(res.body).showConnect).toBe(false);
    vi.clearAllMocks();

    res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ showConnect: true }) });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ showConnect: true, status: 'active' }));
    res = await call({ httpMethod: 'GET' });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('changing the cloud or status returns the join screen to its automatic state', async () => {
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ showConnect: true }) });
    vi.clearAllMocks();

    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
    expect(publishEvent.mock.calls[0][2].showConnect).toBe(false);
    const res = await call({ httpMethod: 'GET' });
    expect(JSON.parse(res.body).showConnect).toBe(false);
  });

  describe('how requests are authenticated', () => {
    it('accepts a request signed by the Storm\'s presenter for this function', async () => {
      const get = await call({ httpMethod: 'GET' });
      expect(get.statusCode).toBe(200);
      expect(JSON.parse(get.body).storm.storm_code).toBe(stormCode);
      expect((await call({ httpMethod: 'PATCH', body: JSON.stringify({ showConnect: true }) })).statusCode).toBe(200);
      expect((await call({ httpMethod: 'DELETE' })).statusCode).toBe(200);
    });

    it('refuses an unsigned request', async () => {
      const res = await handler({ httpMethod: 'GET', headers: {} });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid admin credentials' });
    });

    it('refuses a request signed with another presenter\'s key', async () => {
      const other = await seedStorm(createDb());
      const res = await handler(await other.sign('admin-storm', { httpMethod: 'GET' }, { stormCode }));
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid admin credentials' });
    });

    it('no longer accepts the old x-admin-key header', async () => {
      const res = await handler({ httpMethod: 'GET', headers: { 'x-admin-key': 'a'.repeat(48) } });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a request signed for the other admin function', async () => {
      const res = await handler(await admin.sign('admin-clouds', { httpMethod: 'DELETE' }));
      expect(res.statusCode).toBe(401);
      expect(await getStormByCode(createDb(), stormCode)).not.toBeNull();
    });

    it('does not return a resultsKey', async () => {
      const body = JSON.parse((await call({ httpMethod: 'GET' })).body);
      expect(body).not.toHaveProperty('resultsKey');
    });
  });

  describe('Storm name', () => {
    const patch = (body) => call({ httpMethod: 'PATCH', body: JSON.stringify(body) });
    const name = async () => JSON.parse((await call({ httpMethod: 'GET' })).body).storm.name;

    it('starts unnamed, stores a trimmed name, and clears it with an empty value or null', async () => {
      expect(await name()).toBeNull();
      expect((await patch({ name: '  Quarterly all-hands  ' })).statusCode).toBe(200);
      expect(await name()).toBe('Quarterly all-hands');
      await patch({ name: '' });
      expect(await name()).toBeNull();
      await patch({ name: 'Again' });
      await patch({ name: null });
      expect(await name()).toBeNull();
    });

    it('refuses names that are too long or not text, and keeps the old one', async () => {
      await patch({ name: 'Keep me' });
      for (const bad of ['x'.repeat(81), 42, {}, ['a']]) expect((await patch({ name: bad })).statusCode).toBe(400);
      expect((await patch({ name: 'x'.repeat(80) })).statusCode).toBe(200);
      await patch({ name: 'Keep me' });
      expect((await patch({ name: 'y'.repeat(200) })).statusCode).toBe(400);
      expect(await name()).toBe('Keep me');
    });

    it('does not publish a state event just for a rename', async () => {
      vi.clearAllMocks();
      await patch({ name: 'Quiet' });
      expect(publishEvent).not.toHaveBeenCalled();
    });
  });

  describe('locking voting and the timer', () => {
    const patch = (body) => call({ httpMethod: 'PATCH', body: JSON.stringify({ ...body }) });
    const row = async () => (await createDb().execute({ sql: 'SELECT closes_at FROM clouds WHERE id = ?', args: [cloudId] })).rows[0];
    const detail = async () => JSON.parse((await call({ httpMethod: 'GET' })).body).clouds[0];
    const live = () => patch({ status: 'active', currentCloudId: cloudId });
    const lastState = () => publishEvent.mock.calls.filter((c) => c[1] === 'state').at(-1)[2];

    it('starts open, with no timer', async () => {
      await live();
      expect((await row()).closes_at).toBeNull();
      expect((await detail()).voting_ms_left).toBeNull();
      expect(lastState().currentCloud.votingMsLeft).toBeNull();
    });

    it('starts a timer and tells everyone how long is left', async () => {
      await live();
      vi.clearAllMocks();
      const res = await patch({ votingSeconds: 30 });
      expect(res.statusCode).toBe(200);
      const left = lastState().currentCloud.votingMsLeft;
      expect(left).toBeGreaterThan(29000);
      expect(left).toBeLessThanOrEqual(30000);
      expect((await detail()).voting_ms_left).toBeGreaterThan(29000);
    });

    it('locks voting now, and unlocking clears it', async () => {
      await live();
      await patch({ votingLocked: true });
      expect((await detail()).voting_ms_left).toBe(0);
      expect(lastState().currentCloud.votingMsLeft).toBe(0);
      await patch({ votingLocked: false });
      expect((await row()).closes_at).toBeNull();
      expect(lastState().currentCloud.votingMsLeft).toBeNull();
    });

    it('accepts the clearTimer marker the presenter sends with a content cloud\'s Clear timer, and just unlocks', async () => {
      await live();
      await patch({ votingSeconds: 30 });
      const res = await patch({ votingLocked: false, clearTimer: true });
      expect(res.statusCode).toBe(200);
      expect((await row()).closes_at).toBeNull();
    });

    it('accepts the words marker the presenter sends when locking a word cloud, and just locks and unlocks', async () => {
      await live();
      expect((await patch({ votingLocked: true, words: true })).statusCode).toBe(200);
      expect((await detail()).voting_ms_left).toBe(0);
      expect((await patch({ votingLocked: false, words: true })).statusCode).toBe(200);
      expect((await row()).closes_at).toBeNull();
    });

    it('adds time to a running timer, and reopens a closed cloud for that long', async () => {
      await live();
      await patch({ votingSeconds: 10 });
      await patch({ votingAddSeconds: 30 });
      expect((await detail()).voting_ms_left).toBeGreaterThan(38000);

      await patch({ votingLocked: true });
      await patch({ votingAddSeconds: 20 });
      const left = (await detail()).voting_ms_left;
      expect(left).toBeGreaterThan(19000);
      expect(left).toBeLessThanOrEqual(20000);
    });

    it('refuses bad requests and writes nothing', async () => {
      await live();
      vi.clearAllMocks();
      for (const bad of [{ votingSeconds: 0 }, { votingSeconds: 3601 }, { votingSeconds: 1.5 }, { votingSeconds: '30' }, { votingAddSeconds: -5 }, { votingLocked: true, votingSeconds: 30 }]) {
        expect((await patch(bad)).statusCode).toBe(400);
      }
      expect((await patch({ votingLocked: true, cloudId: 99999 })).statusCode).toBe(400);
      expect((await row()).closes_at).toBeNull();
      expect(publishEvent).not.toHaveBeenCalled();
    });

    it('has nothing to lock when no cloud is live', async () => {
      expect((await patch({ votingLocked: true })).statusCode).toBe(400);
    });

    it('brings a cloud live open again, even if it was locked or timed out before', async () => {
      await live();
      await patch({ votingLocked: true });
      const other = JSON.parse((await callClouds({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Two', options: ['X', 'Y'] }) })).body).id;
      await patch({ status: 'active', currentCloudId: other });
      await patch({ status: 'active', currentCloudId: cloudId });
      expect((await row()).closes_at).toBeNull();
      expect(lastState().currentCloud.votingMsLeft).toBeNull();
    });
  });

  describe('results background colour', () => {
    const patch = (body) => call({ httpMethod: 'PATCH', body: JSON.stringify({ ...body }) });
    const detail = async () => JSON.parse((await call({ httpMethod: 'GET' })).body);

    it('starts with no colour (the default theme)', async () => {
      expect((await detail()).resultsBackground).toBeNull();
    });

    it('stores a colour, normalised to lowercase #rrggbb, and publishes it live in a state event', async () => {
      const res = await patch({ resultsBackground: '1E293B' });
      expect(res.statusCode).toBe(200);
      expect((await detail()).resultsBackground).toBe('#1e293b');
      expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ resultsBackground: '#1e293b' }));
    });

    it('keeps the colour in later state events, and clears it with null', async () => {
      await patch({ resultsBackground: '#ffcc00' });
      vi.clearAllMocks();
      await patch({ status: 'active', currentCloudId: cloudId });
      expect(publishEvent.mock.calls[0][2].resultsBackground).toBe('#ffcc00');

      vi.clearAllMocks();
      await patch({ resultsBackground: null });
      expect(publishEvent.mock.calls[0][2].resultsBackground).toBeNull();
      expect((await detail()).resultsBackground).toBeNull();
    });

    it('refuses anything that is not a hex colour, and stores nothing', async () => {
      for (const bad of ['red', 'url(javascript:alert(1))', '#12345', '#gggggg', 42, {}, '</style><script>']) {
        const res = await patch({ resultsBackground: bad });
        expect(res.statusCode).toBe(400);
      }
      expect((await detail()).resultsBackground).toBeNull();
      expect(publishEvent).not.toHaveBeenCalled();
    });
  });

  it('hides results and only reveals the correct answer when the presenter says so', async () => {
    const created = await callClouds({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Quiz', options: ['X', 'Y', 'Z'], correct: [1, 1, 9], resultsHidden: true }) });
    const qid = JSON.parse(created.body).id;
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: qid }) });
    let payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentCloud).toMatchObject({ resultsHidden: true, correct: null });
    expect(payload.initialTally).toEqual({ totalVotes: 0, hidden: true });

    await call({ httpMethod: 'PATCH', body: JSON.stringify({ resultsHidden: false }) });
    payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentCloud).toMatchObject({ resultsHidden: false, correct: null });
    expect(payload.initialTally.counts).toEqual([0, 0, 0]);

    await call({ httpMethod: 'PATCH', body: JSON.stringify({ answerShown: true }) });
    payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentCloud.correct).toEqual([1]);
  });

  it('lets the presenter hide results for a cloud that is not the live one', async () => {
    const created = await callClouds({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Later', options: ['X', 'Y'] }) });
    const laterId = JSON.parse(created.body).id;
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: cloudId }) });
    const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ cloudId: laterId, resultsHidden: true }) });
    expect(res.statusCode).toBe(200);
    const db = createDb();
    const rows = (await db.execute({ sql: 'SELECT id, results_hidden FROM clouds ORDER BY id', args: [] })).rows;
    expect(rows.find((r) => r.id === laterId).results_hidden).toBe(1);
    expect(rows.find((r) => r.id === cloudId).results_hidden).toBe(0);
  });

  it('returns 400 on malformed JSON in PATCH body', async () => {
    const res = await call({
      httpMethod: 'PATCH',
      body: '{invalid json}',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
