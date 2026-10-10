import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, initSchema, getStormByCode } from '../../lib/db.js';
import { seedStorm } from '../helpers/admin.js';
import { handler } from '../../netlify/functions/admin-clouds.js';
import { publishEvent } from '../../lib/realtime.js';

describe('admin-clouds function', () => {
  let admin;
  const call = (event) => admin.call(handler, 'admin-clouds', event);

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('rejects an unsigned request', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid admin credentials' });
  });

  it('rejects the old x-admin-key header', async () => {
    const res = await handler({ httpMethod: 'GET', headers: { 'x-admin-key': 'a'.repeat(48) } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request signed for the other admin function', async () => {
    const res = await handler(await admin.sign('admin-storm', { httpMethod: 'GET' }));
    expect(res.statusCode).toBe(401);
  });

  it('creates and lists a choice cloud', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    expect(createRes.statusCode).toBe(200);

    const listRes = await call({ httpMethod: 'GET' });
    const { clouds } = JSON.parse(listRes.body);
    expect(clouds).toHaveLength(1);
    expect(clouds[0].body).toBe('Pick one');
  });

  it('resets votes for a cloud', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ cloudId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(200);
  });

  it('deletes a cloud', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const deleteRes = await call({ httpMethod: 'DELETE', body: JSON.stringify({ cloudId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const listRes = await call({ httpMethod: 'GET' });
    const { clouds } = JSON.parse(listRes.body);
    expect(clouds).toHaveLength(0);
  });

  it('rejects malformed JSON bodies with a 400', async () => {
    const res = await call({ httpMethod: 'POST', body: '{not valid json' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
  });

  it('answers an unsigned request with a malformed body 401, not 400', async () => {
    const res = await handler({ httpMethod: 'POST', headers: {}, body: '{not valid json' });
    expect(res.statusCode).toBe(401);
  });

  it('publishes tally and reset events with the correct payloads on reset', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B', 'C'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ cloudId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(200);

    expect(publishEvent).toHaveBeenCalledWith(
      expect.any(String),
      'tally',
      expect.objectContaining({ cloudId: id, counts: [0, 0, 0], totalVotes: 0 })
    );
    expect(publishEvent).toHaveBeenCalledWith(expect.any(String), 'reset', { cloudId: id });
  });

  it('clears current_cloud_id and publishes a state event when the current cloud is deleted', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const db = createDb();
    await db.execute({
      sql: 'UPDATE storms SET current_cloud_id = ?, status = ? WHERE storm_code = ?',
      args: [id, 'active', admin.stormCode],
    });

    const deleteRes = await call({ httpMethod: 'DELETE', body: JSON.stringify({ cloudId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const stormResult = await db.execute({
      sql: 'SELECT current_cloud_id FROM storms WHERE storm_code = ?',
      args: [admin.stormCode],
    });
    expect(stormResult.rows[0].current_cloud_id).toBeNull();

    expect(publishEvent).toHaveBeenCalledWith(
      expect.any(String),
      'state',
      expect.objectContaining({ currentCloud: null })
    );
  });

  it('rejects POST, PATCH and DELETE that are not signed', async () => {
    for (const [httpMethod, body] of [
      ['POST', { kind: 'choice', body: 'Pick one', options: ['A', 'B'] }],
      ['PATCH', { cloudId: 1, action: 'reset' }],
      ['DELETE', { cloudId: 1 }],
    ]) {
      const res = await handler({ httpMethod, headers: {}, body: JSON.stringify(body) });
      expect(res.statusCode).toBe(401);
    }
  });

  it('prevents an admin from mutating another storm\'s cloud (cross-storm IDOR)', async () => {
    const createResA = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Storm A cloud', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createResA.body);

    const adminB = await seedStorm(createDb());
    const callB = (event) => adminB.call(handler, 'admin-clouds', event);

    const patchRes = await callB({
      httpMethod: 'PATCH',
      body: JSON.stringify({ cloudId: id, body: 'Hijacked' }),
    });
    expect(patchRes.statusCode).toBe(404);
    expect(JSON.parse(patchRes.body)).toEqual({ error: 'Cloud not found' });

    const deleteRes = await callB({
      httpMethod: 'DELETE',
      body: JSON.stringify({ cloudId: id }),
    });
    expect(deleteRes.statusCode).toBe(404);

    const resetRes = await callB({
      httpMethod: 'PATCH',
      body: JSON.stringify({ cloudId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(404);

    const listRes = await call({ httpMethod: 'GET' });
    const { clouds } = JSON.parse(listRes.body);
    expect(clouds).toHaveLength(1);
    expect(clouds[0].body).toBe('Storm A cloud');
  });

  it('bumps last_activity_at to now on POST (create cloud)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on PATCH (edit cloud)', async () => {
    const db = createDb();
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ cloudId: id, orderIndex: 3 }),
    });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on DELETE (remove cloud)', async () => {
    const db = createDb();
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({ httpMethod: 'DELETE', body: JSON.stringify({ cloudId: id }) });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('changes only the order outside an edit: other fields there are refused and nothing is stored', async () => {
    const { id } = JSON.parse((await call({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }) })).body);
    const row = async () => (await createDb().execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [id] })).rows[0];
    for (const loose of [{ body: 'x'.repeat(5000) }, { body: '' }, { kind: 'bogus' }, { options: ['only'] }, { scaleMin: 9, scaleMax: 1 }]) {
      const res = await call({ httpMethod: 'PATCH', body: JSON.stringify({ cloudId: id, ...loose }) });
      expect(res.statusCode).toBe(400);
    }
    expect(await row()).toMatchObject({ kind: 'choice', body: 'Pick one', options: '["A","B"]', scale_min: null, scale_max: null });
    const moved = await call({ httpMethod: 'PATCH', body: JSON.stringify({ cloudId: id, orderIndex: 4 }) });
    expect(moved.statusCode).toBe(200);
    expect((await row()).order_index).toBe(4);
  });

  it('publishes the stored numeric id on reset even when the request sent a string', async () => {
    const { id } = JSON.parse((await call({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Pick one', options: ['A', 'B'] }) })).body);
    await call({ httpMethod: 'PATCH', body: JSON.stringify({ cloudId: String(id), action: 'reset' }) });
    expect(publishEvent).toHaveBeenCalledWith(expect.any(String), 'tally', expect.objectContaining({ cloudId: id }));
    expect(publishEvent).toHaveBeenCalledWith(expect.any(String), 'reset', { cloudId: id });
  });

  it('accepts a body of 4000 characters and refuses 4001', async () => {
    const ok = await call({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'x'.repeat(4000), options: ['A', 'B'] }) });
    expect(ok.statusCode).toBe(200);
    const tooLong = await call({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'x'.repeat(4001), options: ['A', 'B'] }) });
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body).error).toBe('The text can be at most 4000 characters');
  });
});

describe('cloud display type', () => {
  it('shapeCloud only reports donut for choice clouds', async () => {
    const { shapeCloud } = await import('../../lib/cloud.js');
    const base = { id: 1, kind: 'choice', body: 'p', options: '["a","b"]' };
    expect(shapeCloud({ ...base, display: 'donut' }).display).toBe('donut');
    expect(shapeCloud({ ...base, display: null }).display).toBe('bars');
    expect(shapeCloud({ ...base, kind: 'rating', display: 'donut' }).display).toBe('bars');
  });
});

describe('cloud editing', () => {
  let admin;
  let stormCode;
  let qid;
  const signed = (event) => admin.call(handler, 'admin-clouds', event);
  const call = (body) => signed({ httpMethod: 'PATCH', body: JSON.stringify({ cloudId: qid, ...body }) });
  const edit = (fields) => call({ edit: { kind: 'choice', body: 'Pick', options: ['A', 'B'], ...fields } });

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
    stormCode = admin.stormCode;
    const created = await signed({ httpMethod: 'POST', body: JSON.stringify({ kind: 'choice', body: 'Pick', options: ['A', 'B'] }) });
    qid = JSON.parse(created.body).id;
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [qid, 'd1', '0', Date.now()] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('keeps votes when only wording, correct answer, display or hiding changes', async () => {
    const res = await edit({ body: 'Pick better', options: ['Alpha', 'Beta'], correct: [1], display: 'donut', resultsHidden: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cleared).toBe(0);
    const db = createDb();
    const row = (await db.execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [qid] })).rows[0];
    expect(row).toMatchObject({ body: 'Pick better', display: 'donut', results_hidden: 1, correct: '[1]' });
    expect((await db.execute({ sql: 'SELECT * FROM votes', args: [] })).rows).toHaveLength(1);
  });

  it('asks before a structural change would clear votes, then clears them when confirmed', async () => {
    const refused = await edit({ options: ['A', 'B', 'C'] });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'needs_clear', votes: 1 });

    const ok = await edit({ options: ['A', 'B', 'C'], clearVotes: true });
    expect(JSON.parse(ok.body).cleared).toBe(1);
    const db = createDb();
    expect((await db.execute({ sql: 'SELECT * FROM votes', args: [] })).rows).toHaveLength(0);
  });

  it('can switch a cloud to a rating scale and validates input', async () => {
    const res = await call({ edit: { kind: 'rating', body: 'Rate', scaleMin: 1, scaleMax: 10, clearVotes: true } });
    expect(res.statusCode).toBe(200);
    expect((await edit({ options: ['only one'] })).statusCode).toBe(400);
    expect((await edit({ body: '  ' })).statusCode).toBe(400);
    expect((await call({ edit: { kind: 'rating', body: 'x', scaleMin: 5, scaleMax: 5 } })).statusCode).toBe(400);
  });

  it('creates a content cloud', async () => {
    const res = await signed({ httpMethod: 'POST', body: JSON.stringify({ kind: 'content', body: '# Hello' }) });
    expect(res.statusCode).toBe(200);
    const row = (await createDb().execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [JSON.parse(res.body).id] })).rows[0];
    expect(row).toMatchObject({ kind: 'content', body: '# Hello' });
  });

  it('switching a cloud with votes to content needs confirmation, then removes the votes', async () => {
    const refused = await call({ edit: { kind: 'content', body: 'Now text' } });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'needs_clear' });

    const ok = await call({ edit: { kind: 'content', body: 'Now text', clearVotes: true } });
    expect(ok.statusCode).toBe(200);
    const db = createDb();
    expect((await db.execute({ sql: 'SELECT * FROM votes', args: [] })).rows).toHaveLength(0);
    expect((await db.execute({ sql: 'SELECT kind FROM clouds WHERE id = ?', args: [qid] })).rows[0].kind).toBe('content');
  });

  it('edits a content cloud body without clearing and publishes state', async () => {
    await call({ edit: { kind: 'content', body: 'Now text', clearVotes: true } });
    const db = createDb();
    await db.execute({ sql: `UPDATE storms SET status = 'active', current_cloud_id = ? WHERE storm_code = ?`, args: [qid, stormCode] });
    vi.clearAllMocks();
    const res = await call({ edit: { kind: 'content', body: 'Revised text' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cleared).toBe(0);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      currentCloud: expect.objectContaining({ body: 'Revised text' }),
    }));
  });

  describe('word clouds', () => {
    let wid;
    const patch = (body) => call(body);
    const vote = (device, words) => createDb().execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [wid, device, JSON.stringify(words), Date.now()] });
    const hidden = async () => (await createDb().execute({ sql: 'SELECT hidden_words FROM clouds WHERE id = ?', args: [wid] })).rows[0].hidden_words;

    beforeEach(async () => {
      const res = await signed({ httpMethod: 'POST', body: JSON.stringify({ kind: 'words', body: 'One word', maxWords: 5 }) });
      wid = JSON.parse(res.body).id;
      await vote('a', ['rude', 'nice']);
      vi.clearAllMocks();
    });

    it('creates a words cloud with its limit', async () => {
      const row = (await createDb().execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [wid] })).rows[0];
      expect(row).toMatchObject({ kind: 'words', max_words: 5 });
    });

    it('hides a word, publishes a tally without it, and is idempotent', async () => {
      const res = await call({ cloudId: wid, hideWord: ' Rude! ' });
      expect(res.statusCode).toBe(200);
      expect(await hidden()).toBe('["rude"]');
      const event = publishEvent.mock.calls.find((c) => c[1] === 'tally')[2];
      expect(event.cloudId).toBe(wid);
      expect(event.words).toEqual([{ word: 'nice', count: 1 }]);
      await call({ cloudId: wid, hideWord: 'rude' });
      expect(await hidden()).toBe('["rude"]');
    });

    it('shows a hidden word again', async () => {
      await call({ cloudId: wid, hideWord: 'rude' });
      vi.clearAllMocks();
      const res = await call({ cloudId: wid, showWord: 'rude' });
      expect(res.statusCode).toBe(200);
      expect(await hidden()).toBe('[]');
      const event = publishEvent.mock.calls.find((c) => c[1] === 'tally')[2];
      expect(event.words.map((w) => w.word)).toEqual(['nice', 'rude']);
    });

    it('refuses hideWord on a choice cloud, an empty word, and an unsigned request', async () => {
      const choice = (await createDb().execute({ sql: `SELECT id FROM clouds WHERE kind = 'choice'`, args: [] })).rows[0].id;
      expect((await call({ cloudId: choice, hideWord: 'x' })).statusCode).toBe(400);
      expect((await call({ cloudId: wid, hideWord: '!!!' })).statusCode).toBe(400);
      const unsigned = await handler({ httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ cloudId: wid, hideWord: 'rude' }) });
      expect(unsigned.statusCode).toBe(401);
      expect(await hidden()).toBeNull();
    });

    it('publishes the stored numeric id when the request sent a string', async () => {
      await call({ cloudId: String(wid), hideWord: 'rude' });
      expect(publishEvent.mock.calls.find((c) => c[1] === 'tally')[2].cloudId).toBe(wid);
      vi.clearAllMocks();
      await call({ cloudId: String(wid), showWord: 'rude' });
      expect(publishEvent.mock.calls.find((c) => c[1] === 'tally')[2].cloudId).toBe(wid);
    });

    it('publishes only the count after a hide while the cloud results are hidden', async () => {
      await createDb().execute({ sql: 'UPDATE clouds SET results_hidden = 1 WHERE id = ?', args: [wid] });
      await call({ cloudId: wid, hideWord: 'rude' });
      const event = publishEvent.mock.calls.find((c) => c[1] === 'tally')[2];
      expect(event).toEqual({ cloudId: wid, totalVotes: 1, hidden: true });
    });

    it('publishes the words after a hide on a closed Storm, even if the cloud results were hidden', async () => {
      await createDb().execute({ sql: 'UPDATE clouds SET results_hidden = 1 WHERE id = ?', args: [wid] });
      await createDb().execute({ sql: `UPDATE storms SET status = 'closed' WHERE storm_code = ?`, args: [stormCode] });
      await call({ cloudId: wid, hideWord: 'rude' });
      const event = publishEvent.mock.calls.find((c) => c[1] === 'tally')[2];
      expect(event.words).toEqual([{ word: 'nice', count: 1 }]);
      expect(event.hidden).toBeUndefined();
    });

    it('forgets removed words when the cloud becomes another kind, so switching back starts clean', async () => {
      await call({ cloudId: wid, hideWord: 'rude' });
      expect(await hidden()).toBe('["rude"]');
      await call({ cloudId: wid, edit: { kind: 'content', body: 'Now text', clearVotes: true } });
      expect(await hidden()).toBeNull();
      await call({ cloudId: wid, edit: { kind: 'words', body: 'Words again', maxWords: 3 } });
      expect(await hidden()).toBeNull();
    });

    it('keeps removed words when a words cloud is edited without changing kind', async () => {
      await call({ cloudId: wid, hideWord: 'rude' });
      await call({ cloudId: wid, edit: { kind: 'words', body: 'Reworded', maxWords: 5 } });
      expect(await hidden()).toBe('["rude"]');
    });

    it('keeps existing responses counted when the limit is lowered', async () => {
      const res = await call({ cloudId: wid, edit: { kind: 'words', body: 'One word', maxWords: 1 } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cleared).toBe(0);
      const row = (await createDb().execute({ sql: 'SELECT * FROM clouds WHERE id = ?', args: [wid] })).rows[0];
      expect(row.max_words).toBe(1);
      const votes = (await createDb().execute({ sql: 'SELECT * FROM votes WHERE cloud_id = ?', args: [wid] })).rows;
      expect(votes).toHaveLength(1);
    });

    it('needs confirmation before turning a words cloud with responses into content', async () => {
      const refused = await call({ cloudId: wid, edit: { kind: 'content', body: 'Now text' } });
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body).code).toBe('needs_clear');
      const ok = await call({ cloudId: wid, edit: { kind: 'content', body: 'Now text', clearVotes: true } });
      expect(ok.statusCode).toBe(200);
    });
  });

  it('publishes the new state when the edited cloud is live', async () => {
    const db = createDb();
    await db.execute({ sql: `UPDATE storms SET status = 'active', current_cloud_id = ? WHERE storm_code = ?`, args: [qid, stormCode] });
    await edit({ body: 'Updated live', display: 'donut' });
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      currentCloud: expect.objectContaining({ body: 'Updated live', display: 'donut' }),
    }));
  });
});
