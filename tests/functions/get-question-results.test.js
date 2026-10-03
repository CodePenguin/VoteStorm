import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, initSchema } from '../../lib/db.js';
import { handler } from '../../netlify/functions/get-question-results.js';

describe('get-question-results function', () => {
  let db;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    for (const code of ['ROOM01', 'ROOM02']) {
      await db.execute({
        sql: `INSERT INTO rooms (admin_key_hash, room_code, status, created_at) VALUES (?, ?, 'active', ?)`,
        args: ['hash-' + code, code, Date.now()],
      });
    }
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, correct, created_at) VALUES (1, 'ROOM01', 0, 'choice', 'Pick', ?, '[1]', ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (2, 'ROOM02', 0, 'choice', 'Other room', ?, ?)`,
      args: [JSON.stringify(['X', 'Y']), Date.now()],
    });
    await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (1, ?, ?, ?)', args: ['d1', '1', Date.now()] });
    await db.execute({ sql: `UPDATE rooms SET current_question_id = 1 WHERE room_code = 'ROOM01'`, args: [] });
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  const get = (q) => handler({ httpMethod: 'GET', queryStringParameters: q });

  it('returns the live question and its tally, keeping the correct answer private', async () => {
    const res = await get({ roomCode: 'ROOM01', questionId: '1' });
    const body = JSON.parse(res.body);
    expect(body.question).toMatchObject({ id: 1, prompt: 'Pick', correct: null, resultsHidden: false });
    expect(body.tally).toEqual({ counts: [0, 1], totalVotes: 1 });
  });

  it('reveals the correct answer once the presenter has shown it', async () => {
    await db.execute({ sql: 'UPDATE questions SET answer_shown = 1 WHERE id = 1', args: [] });
    const body = JSON.parse((await get({ roomCode: 'ROOM01', questionId: '1' })).body);
    expect(body.question.correct).toEqual([1]);
  });

  it('withholds counts while the question results are hidden', async () => {
    await db.execute({ sql: 'UPDATE questions SET results_hidden = 1 WHERE id = 1', args: [] });
    const body = JSON.parse((await get({ roomCode: 'ROOM01', questionId: '1' })).body);
    expect(body.tally).toEqual({ totalVotes: 1, hidden: true });
  });

  it('sends no question or counts when the question is not the live one', async () => {
    await db.execute({ sql: `UPDATE rooms SET current_question_id = NULL WHERE room_code = 'ROOM01'`, args: [] });
    const body = JSON.parse((await get({ roomCode: 'ROOM01', questionId: '1' })).body);
    expect(body).toEqual({ status: 'active', live: false, question: null, tally: null });
  });

  it('shows the question with everything revealed once the room is closed', async () => {
    await db.execute({ sql: `UPDATE rooms SET status = 'closed', current_question_id = NULL WHERE room_code = 'ROOM01'`, args: [] });
    const body = JSON.parse((await get({ roomCode: 'ROOM01', questionId: '1' })).body);
    expect(body.live).toBe(false);
    expect(body.question).toMatchObject({ prompt: 'Pick', correct: [1] });
    expect(body.tally.counts).toEqual([0, 1]);
  });

  it('does not serve a question from a different room', async () => {
    expect((await get({ roomCode: 'ROOM01', questionId: '2' })).statusCode).toBe(404);
    expect((await get({ roomCode: 'NOPE00', questionId: '1' })).statusCode).toBe(404);
    expect((await get({ roomCode: 'ROOM01' })).statusCode).toBe(400);
  });
});
