import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { publishEvent } from '../../lib/realtime.js';
import { createDb, initSchema } from '../../lib/db.js';
import { makeAdmin, seedStorm } from '../helpers/admin.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';
import { handler } from '../../netlify/functions/admin-import.js';
import { handler as adminClouds } from '../../netlify/functions/admin-clouds.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { buildStormFile, stormFileText, MAX_IMPORT_BYTES } from '../../lib/stormFile.js';

describe('admin-import function', () => {
  let db;
  let admin;
  const send = (who, body, headers = {}) =>
    who.call(handler, 'admin-import', { httpMethod: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const add = async (who, cloud) => JSON.parse((await who.call(adminClouds, 'admin-clouds', { httpMethod: 'POST', body: JSON.stringify(cloud) })).body).id;
  const detail = async (who) => JSON.parse((await who.call(adminStorm, 'admin-storm', { httpMethod: 'GET' })).body);
  const exported = async (who) => {
    const data = await detail(who);
    return stormFileText(buildStormFile({ name: data.storm.name, resultsBackground: data.resultsBackground, clouds: data.clouds }));
  };
  const file = (clouds, over = {}) => ({ votestorm: 1, name: 'Imported', resultsBackground: '#102030', clouds, ...over });
  const voteRows = async () => Number((await db.execute('SELECT COUNT(*) AS n FROM votes')).rows[0].n);

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    admin = await seedStorm(db, { name: 'Original' });
    const live = await add(admin, { kind: 'choice', body: 'Old one', options: ['A', 'B'] });
    await add(admin, { kind: 'words', body: 'Old two' });
    await admin.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', body: JSON.stringify({ status: 'active', currentCloudId: live }) });
    await db.execute({ sql: 'INSERT INTO votes (cloud_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [live, 'd1', '0', Date.now()] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('replaces the clouds, name and background with the file\'s, and starts the session over', async () => {
    const res = await send(admin, { storm: file([
      { kind: 'content', body: '# Welcome', timerSeconds: 30, timerAuto: true },
      { kind: 'rating', body: 'Rate', scaleMin: 0, scaleMax: 10 },
    ]) });
    expect(res.statusCode).toBe(200);
    const data = await detail(admin);
    expect(data.storm).toMatchObject({ name: 'Imported', current_cloud_id: null, status: 'lobby' });
    expect(data.resultsBackground).toBe('#102030');
    expect(data.clouds.map((q) => [q.order_index, q.kind, q.body])).toEqual([[0, 'content', '# Welcome'], [1, 'rating', 'Rate']]);
    expect(data.clouds[0]).toMatchObject({ timer_seconds: 30, timer_auto: 1, closes_at: null, hidden_words: null });
    expect(data.clouds[1]).toMatchObject({ scale_min: 0, scale_max: 10 });
    expect(await voteRows()).toBe(0);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledWith(admin.stormCode, 'state', { status: 'lobby', currentCloud: null, initialTally: null, showConnect: true, resultsBackground: '#102030' });
  });

  it('keeps a closed Storm closed', async () => {
    await admin.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
    expect((await send(admin, { storm: file([]) })).statusCode).toBe(200);
    expect((await detail(admin)).storm.status).toBe('closed');
  });

  it('round trip: export, import into any Storm, export again gives the identical file', async () => {
    const source = await seedStorm(db);
    const timed = await add(source, { kind: 'choice', body: '## Pick\n\nmore', options: ['Red', 'Green', 'Blue'], multi: true, correct: [2, 0], display: 'donut', resultsHidden: true, timerSeconds: 45 });
    await add(source, { kind: 'rating', body: 'Rate', scaleMin: -2, scaleMax: 2, timerSeconds: 300, timerAuto: true });
    const words = await add(source, { kind: 'words', body: 'Words 🌩️', maxWords: 7 });
    await add(source, { kind: 'content', body: '> Quote' });
    await source.call(adminClouds, 'admin-clouds', { httpMethod: 'PATCH', body: JSON.stringify({ cloudId: words, hideWord: 'rude' }) });
    await source.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', body: JSON.stringify({ name: 'Ünïcode 🌩️ Storm', resultsBackground: '#0b1120', status: 'active', currentCloudId: timed }) });
    const first = await exported(source);

    expect((await send(admin, { storm: JSON.parse(first) })).statusCode).toBe(200);
    expect(await exported(admin)).toBe(first);
    expect((await send(source, { storm: JSON.parse(first) })).statusCode).toBe(200);
    expect(await exported(source)).toBe(first);
  });

  it('refuses a hostile or broken file and changes nothing', async () => {
    const before = await exported(admin);
    const bad = [
      'not json',
      'null',
      {},
      { storm: null },
      { storm: [] },
      { storm: 'votestorm' },
      { storm: file([], { votestorm: 2 }) },
      { storm: file('clouds') },
      { storm: file([{ kind: 'choice', body: 'x', options: ['only'] }]) },
      { storm: file([{ kind: 'choice', body: 'x', options: [{ toString: null }, 'b'] }]) },
      { storm: file([{ kind: 'choice', body: 'x', options: ['a', 'b'], correct: [{ toString: null }] }]) },
      { storm: file([null]) },
      { storm: file([], { name: 'x'.repeat(81) }) },
      { storm: file([], { resultsBackground: 'javascript:alert(1)' }) },
      { storm: file(Array.from({ length: 101 }, () => ({ kind: 'content', body: 'x' }))) },
    ];
    for (const body of bad) {
      const res = await send(admin, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(JSON.parse(res.body).error).toBeTruthy();
    }
    expect(await exported(admin)).toBe(before);
    expect(await voteRows()).toBe(1);
    expect((await detail(admin)).storm.current_cloud_id).not.toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('answers 413 to a request over the size limit and changes nothing', async () => {
    const res = await send(admin, JSON.stringify({ storm: file([{ kind: 'content', body: 'x'.repeat(MAX_IMPORT_BYTES) }]) }));
    expect(res.statusCode).toBe(413);
    expect((await detail(admin)).clouds).toHaveLength(2);
  });

  it('checks the file\'s cloud count against the license cloud limit', async () => {
    const issuer = await makeIssuer();
    const restore = useIssuer(issuer);
    try {
      const jwt = await issuer.sign({ maxQuestionsPerStorm: 2 });
      const three = file([1, 2, 3].map((n) => ({ kind: 'content', body: `C${n}` })));
      const refused = await send(admin, { storm: three }, bearer(jwt));
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body).code).toBe('cloud_limit');
      expect((await detail(admin)).clouds.map((q) => q.body)).toEqual(['Old one', 'Old two']);
      expect(await voteRows()).toBe(1);
      expect(publishEvent).not.toHaveBeenCalled();
      // The cap is on the file's count, not on the Storm's current clouds plus the file's: two replace two.
      expect((await send(admin, { storm: file(three.clouds.slice(0, 2)) }, bearer(jwt))).statusCode).toBe(200);
      expect((await detail(admin)).clouds.map((q) => q.body)).toEqual(['C1', 'C2']);
      // The limit stays on the Storm, so a later import without the license header is still capped.
      expect((await send(admin, { storm: three })).statusCode).toBe(403);
    } finally {
      restore();
    }
  });

  it('changes nothing when the database fails part way through', async () => {
    await db.execute(`CREATE TRIGGER fail_import BEFORE INSERT ON clouds WHEN NEW.body = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const before = await exported(admin);
    await expect(send(admin, { storm: file([{ kind: 'content', body: 'fine' }, { kind: 'content', body: 'boom' }]) })).rejects.toThrow();
    expect(await exported(admin)).toBe(before);
    expect(await voteRows()).toBe(1);
    expect((await detail(admin)).storm.current_cloud_id).not.toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  describe('who may import', () => {
    const body = () => JSON.stringify({ storm: file([{ kind: 'content', body: 'Hijack' }]) });
    const untouched = async () => expect((await detail(admin)).clouds.map((q) => q.body)).toEqual(['Old one', 'Old two']);

    it('refuses an unsigned request', async () => {
      expect((await handler({ httpMethod: 'POST', headers: {}, body: body() })).statusCode).toBe(401);
      await untouched();
    });

    it('refuses a request signed by another presenter, even naming this Storm', async () => {
      const stranger = await makeAdmin();
      const res = await stranger.call(handler, 'admin-import', { httpMethod: 'POST', headers: {}, body: body() }, { stormCode: admin.stormCode });
      expect(res.statusCode).toBe(401);
      await untouched();
    });

    it('refuses the presenter of another Storm who swaps in this Storm\'s code', async () => {
      const other = await seedStorm(db);
      const event = await other.sign('admin-import', { httpMethod: 'POST', headers: {}, body: body() });
      const forged = { ...event, headers: { 'x-admin-signature': event.headers['x-admin-signature'].replace(other.stormCode, admin.stormCode) } };
      expect((await handler(forged)).statusCode).toBe(401);
      await untouched();
    });

    it('refuses a request signed for another admin function', async () => {
      expect((await handler(await admin.sign('admin-clouds', { httpMethod: 'POST', headers: {}, body: body() }))).statusCode).toBe(401);
      await untouched();
    });

    it('only answers POST', async () => {
      expect((await admin.call(handler, 'admin-import', { httpMethod: 'GET', headers: {} })).statusCode).toBe(405);
    });
  });
});
