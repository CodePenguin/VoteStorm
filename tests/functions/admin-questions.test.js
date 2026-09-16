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
});
