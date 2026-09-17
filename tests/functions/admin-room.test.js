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
import { generateAdminKey, hashAdminKey, deriveRoomCode } from '../../lib/roomCode.js';
import { handler as questionsHandler } from '../../netlify/functions/admin-questions.js';
import { handler } from '../../netlify/functions/admin-room.js';

describe('admin-room function', () => {
  let adminKey, roomCode, questionId;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    adminKey = generateAdminKey();
    roomCode = deriveRoomCode(adminKey);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(adminKey), roomCode, Date.now()],
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

  it('returns room detail with questions and tallies', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const body = JSON.parse(res.body);
    expect(body.room.room_code).toBe(roomCode);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].tally.totalVotes).toBe(0);
  });

  it('activates a question and publishes a state event', async () => {
    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
    });
    expect(res.statusCode).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(roomCode, 'state', expect.objectContaining({ status: 'active' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentQuestion must be shaped like get-room-state.js's output, not the
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

  it('deletes the room and its questions', async () => {
    await handler({ httpMethod: 'DELETE', body: JSON.stringify({ adminKey }) });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects setting currentQuestionId to a question belonging to another room', async () => {
    const db = createDb();
    const otherAdminKey = generateAdminKey();
    const otherRoomCode = deriveRoomCode(otherAdminKey);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(otherAdminKey), otherRoomCode, Date.now()],
    });
    const otherCreateRes = await questionsHandler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey: otherAdminKey, type: 'choice', prompt: 'Other room question', options: ['X', 'Y'] }),
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
    expect(body.room.current_question_id).toBeNull();
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

  it('publishes a state event on a status-only change (closing the room) with no currentQuestionId in the body', async () => {
    // First activate a question so the room has a current_question_id set.
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
    expect(publishEvent).toHaveBeenCalledWith(roomCode, 'state', expect.objectContaining({ status: 'closed' }));

    const publishedPayload = publishEvent.mock.calls[0][2];
    // currentQuestion/initialTally should still be present, re-derived from
    // the room's existing current_question_id, even though the PATCH body
    // didn't include currentQuestionId.
    expect(publishedPayload.currentQuestion).not.toBeNull();
    expect(publishedPayload.currentQuestion.id).toBe(questionId);
    expect(publishedPayload.initialTally).not.toBeNull();
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
