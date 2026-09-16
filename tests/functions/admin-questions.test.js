import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, initSchema } from '../../lib/db.js';
import { generateAdminKey, hashAdminKey, deriveRoomCode } from '../../lib/roomCode.js';
import { handler } from '../../netlify/functions/admin-questions.js';
import { publishEvent } from '../../lib/realtime.js';

describe('admin-questions function', () => {
  let adminKey;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    adminKey = generateAdminKey();
    const roomCode = deriveRoomCode(adminKey);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(adminKey), roomCode, Date.now()],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('rejects requests with a bad admin key', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates and lists a choice question', async () => {
    const createRes = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    expect(createRes.statusCode).toBe(200);

    const listRes = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('Pick one');
  });

  it('resets votes for a question', async () => {
    const createRes = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, questionId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(200);
  });

  it('deletes a question', async () => {
    const createRes = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const deleteRes = await handler({ httpMethod: 'DELETE', body: JSON.stringify({ adminKey, questionId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const listRes = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(0);
  });

  it('rejects malformed JSON bodies with a 400', async () => {
    const res = await handler({ httpMethod: 'POST', body: '{not valid json' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
  });

  it('publishes tally and reset events with the correct payloads on reset', async () => {
    const createRes = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B', 'C'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const resetRes = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey, questionId: id, action: 'reset' }),
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
    const createRes = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createRes.body);

    const db = createDb();
    await db.execute({
      sql: 'UPDATE rooms SET current_question_id = ?, status = ? WHERE admin_key_hash = ?',
      args: [id, 'active', hashAdminKey(adminKey)],
    });

    const deleteRes = await handler({ httpMethod: 'DELETE', body: JSON.stringify({ adminKey, questionId: id }) });
    expect(deleteRes.statusCode).toBe(200);

    const roomResult = await db.execute({
      sql: 'SELECT current_question_id FROM rooms WHERE admin_key_hash = ?',
      args: [hashAdminKey(adminKey)],
    });
    expect(roomResult.rows[0].current_question_id).toBeNull();

    expect(publishEvent).toHaveBeenCalledWith(
      expect.any(String),
      'state',
      expect.objectContaining({ currentQuestion: null })
    );
  });

  it('rejects POST with a bad admin key', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey: 'wrong', type: 'choice', prompt: 'Pick one', options: ['A', 'B'] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects PATCH with a bad admin key', async () => {
    const res = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey: 'wrong', questionId: 1, action: 'reset' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects DELETE with a bad admin key', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      body: JSON.stringify({ adminKey: 'wrong', questionId: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('prevents an admin from mutating another room\'s question (cross-room IDOR)', async () => {
    const createResA = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Room A question', options: ['A', 'B'] }),
    });
    const { id } = JSON.parse(createResA.body);

    const adminKeyB = generateAdminKey();
    const roomCodeB = deriveRoomCode(adminKeyB);
    const db = createDb();
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'lobby', ?)`,
      args: [hashAdminKey(adminKeyB), roomCodeB, Date.now()],
    });

    const patchRes = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey: adminKeyB, questionId: id, prompt: 'Hijacked' }),
    });
    expect(patchRes.statusCode).toBe(404);
    expect(JSON.parse(patchRes.body)).toEqual({ error: 'Question not found' });

    const deleteRes = await handler({
      httpMethod: 'DELETE',
      body: JSON.stringify({ adminKey: adminKeyB, questionId: id }),
    });
    expect(deleteRes.statusCode).toBe(404);

    const resetRes = await handler({
      httpMethod: 'PATCH',
      body: JSON.stringify({ adminKey: adminKeyB, questionId: id, action: 'reset' }),
    });
    expect(resetRes.statusCode).toBe(404);

    const listRes = await handler({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    const { questions } = JSON.parse(listRes.body);
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('Room A question');
  });
});
