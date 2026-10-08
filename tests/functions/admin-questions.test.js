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
import { handler } from '../../netlify/functions/admin-questions.js';
import { publishEvent } from '../../lib/realtime.js';

describe('admin-questions function', () => {
  let admin;
  const call = (event) => admin.call(handler, 'admin-questions', event);

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

  it('creates and lists a choice question', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    expect(createRes.statusCode).toBe(200);

    const listRes = await call({ httpMethod: 'GET' });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('Pick one');
  });

  it('resets votes for a question', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ questionId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(200);
  });

  it('deletes a question', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const deleteRes = await call({ httpMethod: 'DELETE', body: JSON.stringify({ questionId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const listRes = await call({ httpMethod: 'GET' });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(0);
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
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B', 'C'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ questionId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(200);

    expect(publishEvent).toHaveBeenCalledWith(
      expect.any(String),
      'tally',
      expect.objectContaining({ questionId: id, counts: [0, 0, 0], totalVotes: 0 })
    );
    expect(publishEvent).toHaveBeenCalledWith(expect.any(String), 'reset', { questionId: id });
  });

  it('clears current_question_id and publishes a state event when the current question is deleted', async () => {
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const db = createDb();
    await db.execute({
      sql: 'UPDATE storms SET current_question_id = ?, status = ? WHERE storm_code = ?',
      args: [id, 'active', admin.stormCode],
    });

    const deleteRes = await call({ httpMethod: 'DELETE', body: JSON.stringify({ questionId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const stormResult = await db.execute({
      sql: 'SELECT current_question_id FROM storms WHERE storm_code = ?',
      args: [admin.stormCode],
    });
    expect(stormResult.rows[0].current_question_id).toBeNull();

    expect(publishEvent).toHaveBeenCalledWith(
      expect.any(String),
      'state',
      expect.objectContaining({ currentQuestion: null })
    );
  });

  it('rejects POST, PATCH and DELETE that are not signed', async () => {
    for (const [httpMethod, body] of [
      ['POST', { type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }],
      ['PATCH', { questionId: 1, action: 'reset' }],
      ['DELETE', { questionId: 1 }],
    ]) {
      const res = await handler({ httpMethod, headers: {}, body: JSON.stringify(body) });
      expect(res.statusCode).toBe(401);
    }
  });

  it('prevents an admin from mutating another storm\'s question (cross-storm IDOR)', async () => {
    const createResA = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Storm A question', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createResA.body);

    const adminB = await seedStorm(createDb());
    const callB = (event) => adminB.call(handler, 'admin-questions', event);

    const patchRes = await callB({
      httpMethod: 'PATCH',
      body: JSON.stringify({ questionId: id, prompt: 'Hijacked' }),
    });
    expect(patchRes.statusCode).toBe(404);
    expect(JSON.parse(patchRes.body)).toEqual({ error: 'Question not found' });

    const deleteRes = await callB({
      httpMethod: 'DELETE',
      body: JSON.stringify({ questionId: id }),
    });
    expect(deleteRes.statusCode).toBe(404);

    const resetRes = await callB({
      httpMethod: 'PATCH',
      body: JSON.stringify({ questionId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(404);

    const listRes = await call({ httpMethod: 'GET' });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('Storm A question');
  });

  it('bumps last_activity_at to now on POST (create question)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on PATCH (edit question)', async () => {
    const db = createDb();
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({
      httpMethod: 'PATCH',
      body: JSON.stringify({ questionId: id, prompt: 'Updated prompt' }),
    });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on DELETE (remove question)', async () => {
    const db = createDb();
    const createRes = await call({
      httpMethod: 'POST',
      body: JSON.stringify({ type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, admin.stormCode] });

    await call({ httpMethod: 'DELETE', body: JSON.stringify({ questionId: id }) });

    const storm = await getStormByCode(db, admin.stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });
});

describe('question display type', () => {
  it('shapeQuestion only reports donut for choice questions', async () => {
    const { shapeQuestion } = await import('../../lib/question.js');
    const base = { id: 1, type: 'choice', prompt: 'p', options: '["a","b"]' };
    expect(shapeQuestion({ ...base, display: 'donut' }).display).toBe('donut');
    expect(shapeQuestion({ ...base, display: null }).display).toBe('bars');
    expect(shapeQuestion({ ...base, type: 'rating', display: 'donut' }).display).toBe('bars');
  });
});

describe('question editing', () => {
  let admin;
  let stormCode;
  let qid;
  const signed = (event) => admin.call(handler, 'admin-questions', event);
  const call = (body) => signed({ httpMethod: 'PATCH', body: JSON.stringify({ questionId: qid, ...body }) });
  const edit = (fields) => call({ edit: { type: 'choice', prompt: 'Pick', options: ['A', 'B'], ...fields } });

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
    stormCode = admin.stormCode;
    const created = await signed({ httpMethod: 'POST', body: JSON.stringify({ type: 'choice', prompt: 'Pick', options: ['A', 'B'] }) });
    qid = JSON.parse(created.body).id;
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [qid, 'd1', '0', Date.now()] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('keeps votes when only wording, correct answer, display or hiding changes', async () => {
    const res = await edit({ prompt: 'Pick better', options: ['Alpha', 'Beta'], correct: [1], display: 'donut', resultsHidden: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cleared).toBe(0);
    const db = createDb();
    const row = (await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [qid] })).rows[0];
    expect(row).toMatchObject({ prompt: 'Pick better', display: 'donut', results_hidden: 1, correct: '[1]' });
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

  it('can switch a question to a rating scale and validates input', async () => {
    const res = await call({ edit: { type: 'rating', prompt: 'Rate', scaleMin: 1, scaleMax: 10, clearVotes: true } });
    expect(res.statusCode).toBe(200);
    expect((await edit({ options: ['only one'] })).statusCode).toBe(400);
    expect((await edit({ prompt: '  ' })).statusCode).toBe(400);
    expect((await call({ edit: { type: 'rating', prompt: 'x', scaleMin: 5, scaleMax: 5 } })).statusCode).toBe(400);
  });

  it('publishes the new state when the edited question is live', async () => {
    const db = createDb();
    await db.execute({ sql: `UPDATE storms SET status = 'active', current_question_id = ? WHERE storm_code = ?`, args: [qid, stormCode] });
    await edit({ prompt: 'Updated live', display: 'donut' });
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      currentQuestion: expect.objectContaining({ prompt: 'Updated live', display: 'donut' }),
    }));
  });
});
