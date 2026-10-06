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
import { generateAdminKey, hashAdminKey, deriveStormCode } from '../../lib/stormCode.js';
import { handler as questionsHandler } from '../../netlify/functions/admin-questions.js';
import { handler } from '../../netlify/functions/admin-storm.js';

describe('admin-storm function', () => {
  let adminKey, stormCode, questionId;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    adminKey = generateAdminKey();
    stormCode = deriveStormCode(adminKey);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(adminKey), stormCode, Date.now()],
    });
    const createRes = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    questionId = JSON.parse(createRes.body).id;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns storm detail with questions and tallies', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const body = JSON.parse(res.body);
    expect(body.storm.storm_code).toBe(stormCode);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].tally.totalVotes).toBe(0);
  });

  it('activates a question and publishes a state event', async () => {
    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ status: 'active' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentQuestion must be shaped like get-storm-state.js's output, not the
    // raw DB row: options parsed into an array (not a JSON string), and
    // camelCase scale fields (not snake_case scale_min/scale_max).
    expect(Array.isArray(publishedPayload.currentQuestion.options)).toBe(true);
    expect(publishedPayload.currentQuestion.options).toEqual(['A', 'B']);
    expect(publishedPayload.currentQuestion).not.toHaveProperty('scale_min');
    expect(publishedPayload.currentQuestion).not.toHaveProperty('scale_max');
  });

  it('publishes camelCase scaleMin/scaleMax for a rating question', async () => {
    const createRes = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'rating', prompt: 'Rate it', scaleMin: 1, scaleMax: 10 }),
    });
    const ratingQuestionId = JSON.parse(createRes.body).id;
    vi.clearAllMocks();

    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, currentQuestionId: ratingQuestionId }),
    });
    expect(res.statusCode).toBe(200);

    const publishedPayload = publishEvent.mock.calls[0][2];
    expect(publishedPayload.currentQuestion.scaleMin).toBe(1);
    expect(publishedPayload.currentQuestion.scaleMax).toBe(10);
    expect(publishedPayload.currentQuestion).not.toHaveProperty('scale_min');
    expect(publishedPayload.currentQuestion).not.toHaveProperty('scale_max');
    expect(publishedPayload.currentQuestion.options).toBeNull();
  });

  it('bumps last_activity_at to now on PATCH (activate)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, stormCode] });

    await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });

    const storm = await getStormByCode(db, stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('bumps last_activity_at to now on PATCH (reset action)', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 3600000, stormCode] });

    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, action: 'reset' }) });

    const storm = await getStormByCode(db, stormCode);
    expect(Number(storm.last_activity_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('deletes the storm and its questions', async () => {
    await handler({ httpMethod: 'DELETE', body: JSON.stringify({ adminKey }) });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects setting currentQuestionId to a question belonging to another storm', async () => {
    const db = createDb();
    const otherAdminKey = generateAdminKey();
    const otherStormCode = deriveStormCode(otherAdminKey);
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, storm_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(otherAdminKey), otherStormCode, Date.now()],
    });
    const otherCreateRes = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey: otherAdminKey, type: 'choice', prompt: 'Other storm question', options: ['X', 'Y'] }),
    });
    const otherQuestionId = JSON.parse(otherCreateRes.body).id;
    vi.clearAllMocks();

    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, currentQuestionId: otherQuestionId }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid questionId' });
    expect(publishEvent).not.toHaveBeenCalled();

    const getRes = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const body = JSON.parse(getRes.body);
    expect(body.storm.current_question_id).toBeNull();
  });

  it('publishes the real tally (not zeroed) when activating a question that already has votes', async () => {
    // Activate the question once, then record a vote directly against it,
    // then "re-activate" it (e.g. presenter clicking Activate again after a
    // partial reset). The republished state event must reflect the real
    // vote count, not an empty tally.
    const db = createDb();
    await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });
    await db.execute({
      sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)',
      args: [questionId, 'dev-x', '0', Date.now()],
    });
    vi.clearAllMocks();

    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });
    expect(res.statusCode).toBe(200);

    const publishedPayload = publishEvent.mock.calls[0][2];
    expect(publishedPayload.initialTally.totalVotes).toBe(1);
    expect(publishedPayload.initialTally.counts).toEqual([1, 0]);
  });

  it('publishes a state event on a status-only change (closing the storm) with no currentQuestionId in the body', async () => {
    // First activate a question so the storm has a current_question_id set.
    await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });
    vi.clearAllMocks();

    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'closed' }),
    });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ status: 'closed' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentQuestion/initialTally should still be present, re-derived from
    // the storm's existing current_question_id, even though the PATCH body
    // didn't include currentQuestionId.
    expect(publishedPayload.currentQuestion).not.toBeNull();
    expect(publishedPayload.currentQuestion.id).toBe(questionId);
    expect(publishedPayload.initialTally).not.toBeNull();
  });

  it('showConnect defaults to visible in an empty lobby and is reported on GET', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('presenter can show the join screen during a live question and it persists, publishing a state event', async () => {
    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }) });
    let res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(JSON.parse(res.body).showConnect).toBe(false);
    vi.clearAllMocks();

    res = await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, showConnect: true }) });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({ showConnect: true, status: 'active' }));
    res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(JSON.parse(res.body).showConnect).toBe(true);
  });

  it('changing the question or status returns the join screen to its automatic state', async () => {
    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }) });
    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, showConnect: true }) });
    vi.clearAllMocks();

    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'closed' }) });
    expect(publishEvent.mock.calls[0][2].showConnect).toBe(false);
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(JSON.parse(res.body).showConnect).toBe(false);
  });

  describe('results background colour', () => {
    const patch = (body) => handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, ...body }) });
    const detail = async () => JSON.parse((await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } })).body);

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
      await patch({ status: 'active', currentQuestionId: questionId });
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
    const created = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Quiz', options: ['X', 'Y', 'Z'], correct: [1, 1, 9], resultsHidden: true }),
    });
    const qid = JSON.parse(created.body).id;
    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: qid }) });
    let payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentQuestion).toMatchObject({ resultsHidden: true, correct: null });
    expect(payload.initialTally).toEqual({ totalVotes: 0, hidden: true });

    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, resultsHidden: false }) });
    payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentQuestion).toMatchObject({ resultsHidden: false, correct: null });
    expect(payload.initialTally.counts).toEqual([0, 0, 0]);

    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, answerShown: true }) });
    payload = publishEvent.mock.calls.at(-1)[2];
    expect(payload.currentQuestion.correct).toEqual([1]);
  });

  it('lets the presenter hide results for a question that is not the live one', async () => {
    const created = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Later', options: ['X', 'Y'] }),
    });
    const laterId = JSON.parse(created.body).id;
    await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }) });
    const res = await handler({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, questionId: laterId, resultsHidden: true }) });
    expect(res.statusCode).toBe(200);
    const db = createDb();
    const rows = (await db.execute({ sql: 'SELECT id, results_hidden FROM questions ORDER BY id', args: [] })).rows;
    expect(rows.find((r) => r.id === laterId).results_hidden).toBe(1);
    expect(rows.find((r) => r.id === questionId).results_hidden).toBe(0);
  });

  it('returns 400 on malformed JSON in PATCH body', async () => {
    const res = await handler({
      httpMethod: 'PATCH',
      body: '{invalid json}',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
