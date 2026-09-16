import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handler } from '../../netlify/functions/create-room.js';

describe('create-room function', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'livepoll-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('creates a room and returns adminKey + roomCode', async () => {
    const res = await handler({ httpMethod: 'POST' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.adminKey).toMatch(/^[0-9a-f]{48}$/);
    expect(body.roomCode).toHaveLength(6);
  });

  it('rejects non-POST methods', async () => {
    const res = await handler({ httpMethod: 'GET' });
    expect(res.statusCode).toBe(405);
  });
});
