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
import { deriveResultsKey, hashResultsKey, deriveStormCode, hashAdminKey } from '../../lib/stormCode.js';
import { handler as createStorm } from '../../netlify/functions/create-storm.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { handler as questions } from '../../netlify/functions/admin-questions.js';
import { handler as resolveKey } from '../../netlify/functions/resolve-results-key.js';
import { handler as activate } from '../../netlify/functions/results-activate.js';

describe('results key', () => {
  let adminKey;
  let stormCode;
  let resultsKey;
  let q1;
  let q2;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    const created = JSON.parse((await createStorm({ httpMethod: 'POST' })).body);
    adminKey = created.adminKey;
    stormCode = created.stormCode;
    resultsKey = deriveResultsKey(adminKey);
    const add = async (prompt) => JSON.parse((await questions({
      httpMethod: 'POST',
      body: JSON.stringify({ adminKey, type: 'choice', prompt, options: ['A', 'B'] }),
    })).body).id;
    q1 = await add('One');
    q2 = await add('Two');
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  const resolve = (key) => resolveKey({ httpMethod: 'GET', queryStringParameters: { key } });
  const go = (body) => activate({ httpMethod: 'POST', body: JSON.stringify(body) });

  it('is derived from the admin key, is stable, and cannot be recomputed from the stored hash', () => {
    expect(deriveResultsKey(adminKey)).toBe(resultsKey);
    expect(resultsKey).toMatch(/^[0-9a-f]{24}$/);
    expect(resultsKey).not.toContain(deriveStormCode(adminKey).toLowerCase());
    expect(resultsKey).not.toBe(hashAdminKey(adminKey).slice(0, 24));
  });

  it('is stored (hashed) when the storm is created and returned by the presenter GET', async () => {
    const body = JSON.parse((await adminStorm({ httpMethod: 'GET', queryStringParameters: { adminKey } })).body);
    expect(body.resultsKey).toBe(resultsKey);
    expect(body.storm.results_key_hash).toBe(hashResultsKey(resultsKey));
  });

  it('backfills the hash for storms created before results keys existed', async () => {
    const db = createDb();
    await db.execute({ sql: 'UPDATE storms SET results_key_hash = NULL', args: [] });
    expect((await resolve(resultsKey)).statusCode).toBe(404);
    await adminStorm({ httpMethod: 'GET', queryStringParameters: { adminKey } });
    expect(JSON.parse((await resolve(resultsKey)).body)).toEqual({ stormCode });
  });

  it('resolves a results key to its storm and rejects a plain storm code', async () => {
    expect(JSON.parse((await resolve(resultsKey)).body)).toEqual({ stormCode });
    expect((await resolve(stormCode)).statusCode).toBe(404);
    expect((await resolve('nonsense')).statusCode).toBe(404);
  });

  it('makes a question live from the results key and publishes the state', async () => {
    const res = await go({ resultsKey, questionId: q2 });
    expect(JSON.parse(res.body)).toEqual({ ok: true, changed: true });
    expect(publishEvent).toHaveBeenCalledWith(stormCode, 'state', expect.objectContaining({
      status: 'active',
      currentQuestion: expect.objectContaining({ id: q2, prompt: 'Two' }),
    }));
    const body = JSON.parse((await adminStorm({ httpMethod: 'GET', queryStringParameters: { adminKey } })).body);
    expect(body.storm.current_question_id).toBe(q2);
  });

  it('does nothing (and publishes nothing) when the question is already live', async () => {
    await go({ resultsKey, questionId: q1 });
    vi.clearAllMocks();
    expect(JSON.parse((await go({ resultsKey, questionId: q1 })).body).changed).toBe(false);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('never reopens a closed storm', async () => {
    await adminStorm({ httpMethod: 'PATCH', body: JSON.stringify({ adminKey, status: 'closed' }) });
    vi.clearAllMocks();
    const res = await go({ resultsKey, questionId: q2 });
    expect(JSON.parse(res.body)).toMatchObject({ changed: false, closed: true });
    expect(publishEvent).not.toHaveBeenCalled();
    const body = JSON.parse((await adminStorm({ httpMethod: 'GET', queryStringParameters: { adminKey } })).body);
    expect(body.storm.status).toBe('closed');
    expect(body.storm.current_question_id).not.toBe(q2);
  });

  it('refuses a storm code, a wrong key, or a question from another storm', async () => {
    expect((await go({ resultsKey: stormCode, questionId: q1 })).statusCode).toBe(401);
    expect((await go({ resultsKey: 'f'.repeat(24), questionId: q1 })).statusCode).toBe(401);
    expect((await go({ resultsKey, questionId: 99999 })).statusCode).toBe(404);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
