import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { generateAdminKey, hashAdminKey, deriveRoomCode } from '../../lib/roomCode.js';
import { handler } from '../../netlify/functions/get-room-results.js';

describe('get-room-results function', () => {
  let roomCode;
  let db;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    const adminKey = generateAdminKey();
    roomCode = deriveRoomCode(adminKey);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'closed', ?)`,
      args: [hashAdminKey(adminKey), roomCode, Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (1, ?, 0, 'choice', 'Pick one', ?, ?)`,
      args: [roomCode, JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, scale_min, scale_max, created_at) VALUES (2, ?, 1, 'rating', 'Rate it', 1, 5, ?)`,
      args: [roomCode, Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d1', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d2', '0', Date.now()] });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (2, ?, ?, ?)', args: ['d1', '4', Date.now()] });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('returns every question in order with its tally when the room is closed', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode } });
    expect(res.statusCode).toBe(200);
    const { questions } = JSON.parse(res.body);
    expect(questions.map((q) => q.prompt)).toEqual(['Pick one', 'Rate it']);
    expect(questions[0]).toMatchObject({ id: 1, type: 'choice', options: ['A', 'B'], tally: { counts: [2, 0], totalVotes: 2 } });
    expect(questions[1]).toMatchObject({ id: 2, type: 'rating', scaleMin: 1, scaleMax: 5, options: null });
    expect(questions[1].tally.average).toBe(4);
  });

  it('includes questions that have zero votes', async () => {
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (3, ?, 2, 'choice', 'Empty', ?, ?)`,
      args: [roomCode, JSON.stringify(['X', 'Y']), Date.now()],
    });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode } });
    const { questions } = JSON.parse(res.body);
    expect(questions[2].tally).toEqual({ counts: [0, 0], totalVotes: 0 });
  });

  it('returns an empty list for a closed room with no questions', async () => {
    await db.execute({ sql: 'DELETE FROM votes', args: [] });
    await db.execute({ sql: 'DELETE FROM questions', args: [] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ questions: [] });
  });

  it('refuses with 403 and no results while the room is still open', async () => {
    await db.execute({ sql: `UPDATE rooms SET status = 'active' WHERE room_code = ?`, args: [roomCode] });
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).questions).toBeUndefined();
  });

  it('404s for an unknown room', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode: 'NOPE00' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s without a roomCode and 405s for non-GET', async () => {
    expect((await handler({ httpMethod: 'GET', queryStringParameters: {} })).statusCode).toBe(400);
    expect((await handler({ httpMethod: 'POST', queryStringParameters: { roomCode } })).statusCode).toBe(405);
  });
});
