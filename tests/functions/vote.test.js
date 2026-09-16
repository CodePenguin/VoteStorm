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
import { handler } from '../../netlify/functions/vote.js';

describe('vote function', () => {
  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const db = createDb();
    await initSchema(db);
    await db.execute({
      sql: `INSERT INTO rooms (admin_key_hash, room_code, status, current_question_id, created_at) VALUES (?, ?, 'active', 1, ?)`,
      args: ['hash1', 'ROOM01', Date.now()],
    });
    await db.execute({
      sql: `INSERT INTO questions (id, room_code, order_index, type, prompt, options, created_at) VALUES (1, 'ROOM01', 0, 'choice', 'Pick one', ?, ?)`,
      args: [JSON.stringify(['A', 'B']), Date.now()],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('records a vote and publishes a tally', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 0 }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tally.counts).toEqual([1, 0]);
    expect(publishEvent).toHaveBeenCalledWith('ROOM01', 'tally', expect.objectContaining({ questionId: 1 }));
  });

  it('rejects a second vote from the same device', async () => {
    await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 0 }),
    });
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 1, deviceId: 'dev-a', value: 1 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a vote for a question that is not currently active', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ roomCode: 'ROOM01', questionId: 99, deviceId: 'dev-b', value: 0 }),
    });
    expect(res.statusCode).toBe(409);
  });
});
