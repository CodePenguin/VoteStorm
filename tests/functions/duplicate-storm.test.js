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

describe('duplicate-storm function', () => {
  let issuer;
  let restore;
  let source;

  beforeAll(async () => {
    issuer = await makeIssuer();
  });

  const post = (fn, body, jwt) => fn({ httpMethod: 'POST', headers: jwt ? bearer(jwt) : {}, body: JSON.stringify(body) });
  const patch = (body) => adminStorm({ httpMethod: 'PATCH', headers: {}, body: JSON.stringify(body) });
  const detail = async (adminKey) => JSON.parse((await adminStorm({ httpMethod: 'GET', headers: { ...{}, 'x-admin-key': adminKey } })).body);
  const row = async (stormCode) => (await createDb().execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stormCode] })).rows[0];
  const count = async (table, stormCode) =>
    Number((await createDb().execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE storm_code = ?`, args: [stormCode] })).rows[0].n);

  async function makeSource(jwt) {
    const created = JSON.parse((await post(createStorm, {}, jwt)).body);
    const { adminKey } = created;
    const add = async (q) => JSON.parse((await post(adminQuestions, { adminKey, ...q }, jwt)).body).id;
    const choiceId = await add({ type: 'choice', prompt: 'Pick', options: ['A', 'B', 'C'], correct: [1], display: 'donut', resultsHidden: true });
    await add({ type: 'rating', prompt: 'Rate it', scaleMin: 1, scaleMax: 5 });
    await patch({ adminKey, resultsBackground: '#1e293b' });
    await patch({ adminKey, status: 'active', currentQuestionId: choiceId });
    await post(vote, { stormCode: created.stormCode, questionId: choiceId, deviceId: 'dev-1', value: 0 });
    await patch({ adminKey, questionId: choiceId, votingLocked: true });
    return { ...created, choiceId };
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
    const res = await post(duplicateStorm, { adminKey: source.adminKey });
    expect(res.statusCode).toBe(200);
    const copy = JSON.parse(res.body);
    expect(copy.adminKey).not.toBe(source.adminKey);
    expect(copy.stormCode).not.toBe(source.stormCode);

    const data = await detail(copy.adminKey);
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
    await post(duplicateStorm, { adminKey: source.adminKey });
    const original = await detail(source.adminKey);
    expect(original.questions).toHaveLength(2);
    expect(original.questions[0].tally.totalVotes).toBe(1);
    expect(original.questions[0].voting_ms_left).toBe(0);
    expect(original.storm.status).toBe('active');
  });

  it('gives the copy its own results key and storm code, so the two never mix', async () => {
    const copy = JSON.parse((await post(duplicateStorm, { adminKey: source.adminKey })).body);
    const [a, b] = [await detail(source.adminKey), await detail(copy.adminKey)];
    expect(a.resultsKey).not.toBe(b.resultsKey);
    expect(await count('questions', source.stormCode)).toBe(2);
    expect(await count('questions', copy.stormCode)).toBe(2);
  });

  it('takes the admin key from the x-admin-key header, and names the copy after the original', async () => {
    await adminStorm({ httpMethod: 'PATCH', headers: { 'x-admin-key': source.adminKey }, body: JSON.stringify({ name: 'Town hall' }) });
    const res = await duplicateStorm({ httpMethod: 'POST', headers: { 'x-admin-key': source.adminKey }, body: '{}' });
    expect(res.statusCode).toBe(200);
    const copy = JSON.parse(res.body);
    expect((await row(copy.stormCode)).name).toBe('Copy of Town hall');
    expect((await row(source.stormCode)).name).toBe('Town hall');
    const unnamed = JSON.parse((await post(duplicateStorm, { adminKey: (await post(createStorm, {})).body && JSON.parse((await post(createStorm, {})).body).adminKey })).body);
    expect((await row(unnamed.stormCode)).name).toBeNull();
  });

  it('refuses a wrong or missing admin key', async () => {
    expect((await post(duplicateStorm, { adminKey: 'nope' })).statusCode).toBe(401);
    expect((await post(duplicateStorm, {})).statusCode).toBe(401);
    expect((await post(duplicateStorm, { adminKey: 42 })).statusCode).toBe(401);
    expect((await duplicateStorm({ httpMethod: 'POST', headers: {}, body: '{' })).statusCode).toBe(400);
    expect((await duplicateStorm({ httpMethod: 'GET', headers: {} })).statusCode).toBe(405);
  });

  it('makes the copy under the license of whoever asks, and records them as its creator', async () => {
    const jwt = await issuer.sign({ name: 'Acme', stormInactivityHours: 72 }, { sub: 'acme' });
    const copy = JSON.parse((await post(duplicateStorm, { adminKey: source.adminKey }, jwt)).body);
    const stored = await row(copy.stormCode);
    expect(stored).toMatchObject({ created_by_license_id: 'acme', created_by_license_name: 'Acme', license_id: 'acme' });
    expect(Number(stored.inactivity_hours)).toBe(72);
    // The original stays with its own creator.
    expect((await row(source.stormCode)).created_by_license_id).toBe('anonymous');
  });

  it('counts the copy toward the active-Storm limit', async () => {
    const jwt = await issuer.sign({ name: 'Acme', maxActiveStorms: 1 }, { sub: 'acme' });
    expect((await post(duplicateStorm, { adminKey: source.adminKey }, jwt)).statusCode).toBe(200);
    const second = await post(duplicateStorm, { adminKey: source.adminKey }, jwt);
    expect(second.statusCode).toBe(403);
    expect(JSON.parse(second.body)).toMatchObject({ code: 'storm_limit' });
  });

  it('refuses when the copy would exceed the requester\'s question limit, and creates nothing', async () => {
    const jwt = await issuer.sign({ name: 'Small', maxQuestionsPerStorm: 1 }, { sub: 'small' });
    const res = await post(duplicateStorm, { adminKey: source.adminKey }, jwt);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'question_limit' });
    const stormCount = Number((await createDb().execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n);
    expect(stormCount).toBe(1);
  });

  it('removes the new Storm again if copying the questions fails', async () => {
    const db = createDb();
    await db.execute('CREATE TRIGGER no_copies BEFORE INSERT ON questions WHEN NEW.storm_code != \'' + source.stormCode + '\' BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    await expect(post(duplicateStorm, { adminKey: source.adminKey })).rejects.toThrow();
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(1);
    await db.execute('DROP TRIGGER no_copies');
  });
});
