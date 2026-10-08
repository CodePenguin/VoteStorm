import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb } from '../../lib/db.js';
import { handler as createStorm } from '../../netlify/functions/create-storm.js';
import { handler as duplicateStorm } from '../../netlify/functions/duplicate-storm.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { handler as adminQuestions } from '../../netlify/functions/admin-questions.js';
import { handler as vote } from '../../netlify/functions/vote.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';
import { makeAdmin } from '../helpers/admin.js';

describe('duplicate-storm function', () => {
  let issuer;
  let restore;
  let source;

  beforeAll(async () => {
    issuer = await makeIssuer();
  });

  const post = (fn, body, jwt) => fn({ httpMethod: 'POST', headers: jwt ? bearer(jwt) : {}, body: JSON.stringify(body) });
  const detail = async (admin) => JSON.parse((await admin.call(adminStorm, 'admin-storm', { httpMethod: 'GET' })).body);
  const row = async (stormCode) => (await createDb().execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stormCode] })).rows[0];
  const count = async (table, stormCode) =>
    Number((await createDb().execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE storm_code = ?`, args: [stormCode] })).rows[0].n);
  const stormTotal = async () => Number((await createDb().execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n);

  // Asks to duplicate `from`, signed by `signer` (the source's presenter unless told otherwise), into a Storm owned by a fresh presenter.
  async function duplicate({ from = source, signer = from, jwt, body } = {}) {
    const copy = await makeAdmin();
    const event = {
      httpMethod: 'POST',
      headers: jwt ? bearer(jwt) : {},
      body: body ?? JSON.stringify({ publicKey: copy.publicKey, resultsKeyHash: copy.resultsKeyHash }),
    };
    const res = await signer.call(duplicateStorm, 'duplicate-storm', event, { stormCode: from.stormCode });
    if (res.statusCode === 200) copy.stormCode = JSON.parse(res.body).stormCode;
    return { res, copy, event };
  }

  async function makeSource(jwt) {
    const admin = await makeAdmin();
    const created = await post(createStorm, { publicKey: admin.publicKey, resultsKeyHash: admin.resultsKeyHash }, jwt);
    admin.stormCode = JSON.parse(created.body).stormCode;
    const add = async (q) => JSON.parse((await admin.call(adminQuestions, 'admin-questions', { httpMethod: 'POST', headers: jwt ? bearer(jwt) : {}, body: JSON.stringify(q) })).body).id;
    const patch = (body) => admin.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', headers: {}, body: JSON.stringify(body) });
    const choiceId = await add({ type: 'choice', prompt: 'Pick', options: ['A', 'B', 'C'], correct: [1], display: 'donut', resultsHidden: true });
    await add({ type: 'rating', prompt: 'Rate it', scaleMin: 1, scaleMax: 5 });
    await patch({ resultsBackground: '#1e293b' });
    await patch({ status: 'active', currentQuestionId: choiceId });
    await post(vote, { stormCode: admin.stormCode, questionId: choiceId, deviceId: 'dev-1', value: 0 });
    await patch({ questionId: choiceId, votingLocked: true });
    return admin;
  }

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    restore = useIssuer(issuer);
    source = await makeSource();
  });

  afterEach(() => {
    restore();
    delete process.env.TURSO_DATABASE_URL;
  });

  it('copies the questions and the background into a new Storm, without votes, lock or live question', async () => {
    const { res, copy } = await duplicate();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('adminKey');
    expect(copy.stormCode).toHaveLength(8);
    expect(copy.stormCode).not.toBe(source.stormCode);

    const data = await detail(copy);
    expect(data.questions.map((q) => q.prompt)).toEqual(['Pick', 'Rate it']);
    expect(data.questions.map((q) => q.order_index)).toEqual([0, 1]);
    expect(data.questions[0]).toMatchObject({ type: 'choice', options: JSON.stringify(['A', 'B', 'C']), correct: JSON.stringify([1]), display: 'donut', results_hidden: 1 });
    expect(data.questions[1]).toMatchObject({ type: 'rating', scale_min: 1, scale_max: 5 });
    expect(data.questions.every((q) => q.tally.totalVotes === 0)).toBe(true);
    expect(data.questions.every((q) => q.voting_ms_left === null)).toBe(true);
    expect(data.resultsBackground).toBe('#1e293b');
    expect(data.storm).toMatchObject({ status: 'lobby', current_question_id: null });
  });

  it('leaves the original untouched', async () => {
    await duplicate();
    const original = await detail(source);
    expect(original.questions).toHaveLength(2);
    expect(original.questions[0].tally.totalVotes).toBe(1);
    expect(original.questions[0].voting_ms_left).toBe(0);
    expect(original.storm.status).toBe('active');
  });

  it('gives the copy its own keys and storm code, so the two never mix', async () => {
    const { copy } = await duplicate();
    const [a, b] = [await row(source.stormCode), await row(copy.stormCode)];
    expect(b.admin_public_key).toBe(copy.publicKey);
    expect(b.admin_public_key).not.toBe(a.admin_public_key);
    expect(b.results_key_hash).toBe(copy.resultsKeyHash);
    expect(b.results_key_hash).not.toBe(a.results_key_hash);
    expect(await count('questions', source.stormCode)).toBe(2);
    expect(await count('questions', copy.stormCode)).toBe(2);
  });

  it('names the copy after the original', async () => {
    await source.call(adminStorm, 'admin-storm', { httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ name: 'Town hall' }) });
    const { res, copy } = await duplicate();
    expect(res.statusCode).toBe(200);
    expect((await row(copy.stormCode)).name).toBe('Copy of Town hall');
    expect((await row(source.stormCode)).name).toBe('Town hall');

    const other = await makeAdmin();
    const created = await post(createStorm, { publicKey: other.publicKey, resultsKeyHash: other.resultsKeyHash });
    other.stormCode = JSON.parse(created.body).stormCode;
    const unnamed = await duplicate({ from: other });
    expect((await row(unnamed.copy.stormCode)).name).toBeNull();
  });

  it('refuses an unsigned request, bad credentials for the copy, and the wrong method', async () => {
    const copy = await makeAdmin();
    const unsigned = await post(duplicateStorm, { publicKey: copy.publicKey, resultsKeyHash: copy.resultsKeyHash });
    expect(unsigned.statusCode).toBe(401);
    expect(JSON.parse(unsigned.body)).toEqual({ error: 'Invalid admin credentials' });
    expect((await post(duplicateStorm, {})).statusCode).toBe(400);
    expect((await duplicateStorm({ httpMethod: 'POST', headers: {}, body: '{' })).statusCode).toBe(400);
    expect((await duplicateStorm({ httpMethod: 'GET', headers: {} })).statusCode).toBe(405);
    expect((await duplicate({ body: JSON.stringify({ publicKey: copy.publicKey, resultsKeyHash: 'nope' }) })).res.statusCode).toBe(400);
    expect(await stormTotal()).toBe(1);
  });

  it('refuses a duplicate signed by the wrong presenter', async () => {
    const stranger = await makeAdmin();
    const { res } = await duplicate({ signer: stranger });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid admin credentials' });
    expect(await stormTotal()).toBe(1);
  });

  it('refuses a request signed for another function', async () => {
    const copy = await makeAdmin();
    const event = { httpMethod: 'POST', headers: {}, body: JSON.stringify({ publicKey: copy.publicKey, resultsKeyHash: copy.resultsKeyHash }) };
    const res = await duplicateStorm(await source.sign('admin-storm', event));
    expect(res.statusCode).toBe(401);
    expect(await stormTotal()).toBe(1);
  });

  it('refuses to replay a signed duplicate request, and makes no second copy', async () => {
    const { res, event } = await duplicate();
    expect(res.statusCode).toBe(200);
    const replay = await duplicateStorm(await source.sign('duplicate-storm', event));
    expect(replay.statusCode).toBe(409);
    expect(await stormTotal()).toBe(2);
  });

  it('makes the copy under the license of whoever asks, and records them as its creator', async () => {
    const jwt = await issuer.sign({ name: 'Acme', stormInactivityHours: 72 }, { sub: 'acme' });
    const { copy } = await duplicate({ jwt });
    const stored = await row(copy.stormCode);
    expect(stored).toMatchObject({ created_by_license_id: 'acme', created_by_license_name: 'Acme', license_id: 'acme' });
    expect(Number(stored.inactivity_hours)).toBe(72);
    // The original stays with its own creator.
    expect((await row(source.stormCode)).created_by_license_id).toBe('anonymous');
  });

  it('counts the copy toward the active-Storm limit', async () => {
    const jwt = await issuer.sign({ name: 'Acme', maxActiveStorms: 1 }, { sub: 'acme' });
    expect((await duplicate({ jwt })).res.statusCode).toBe(200);
    const second = (await duplicate({ jwt })).res;
    expect(second.statusCode).toBe(403);
    expect(JSON.parse(second.body)).toMatchObject({ code: 'storm_limit' });
  });

  it('refuses when the copy would exceed the requester\'s question limit, and creates nothing', async () => {
    const jwt = await issuer.sign({ name: 'Small', maxQuestionsPerStorm: 1 }, { sub: 'small' });
    const { res } = await duplicate({ jwt });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'question_limit' });
    expect(await stormTotal()).toBe(1);
  });

  it('removes the new Storm again if copying the questions fails', async () => {
    const db = createDb();
    await db.execute('CREATE TRIGGER no_copies BEFORE INSERT ON questions WHEN NEW.storm_code != \'' + source.stormCode + '\' BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    await expect(duplicate()).rejects.toThrow();
    expect(await stormTotal()).toBe(1);
    await db.execute('DROP TRIGGER no_copies');
  });
});
