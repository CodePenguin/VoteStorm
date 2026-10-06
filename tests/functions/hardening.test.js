import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, deleteStormCascade, getDbUrl, initSchema } from '../../lib/db.js';
import { handler as createStorm } from '../../netlify/functions/create-storm.js';
import { handler as adminQuestions } from '../../netlify/functions/admin-questions.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
import { handler as vote } from '../../netlify/functions/vote.js';
import { MAX_OPTIONS, MAX_OPTION_LENGTH, MAX_PROMPT_LENGTH, MAX_SCALE_VALUES } from '../../lib/questionInput.js';

const ip = (n) => ({ 'x-nf-client-connection-ip': `203.0.113.${n}` });

describe('hardening', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    // Rate-limit windows are one minute long; hold the clock mid-window so a burst of requests cannot straddle two.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T12:00:10Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.RATE_LIMIT_SCALE;
  });

  const newStorm = async (headers = {}) => JSON.parse((await createStorm({ httpMethod: 'POST', headers })).body);
  const addQuestion = (adminKey, fields, headers = {}) => adminQuestions({
    httpMethod: 'POST', headers, body: JSON.stringify({ adminKey, type: 'choice', prompt: 'Q', options: ['A', 'B'], ...fields }),
  });

  describe('storm creation', () => {
    it('limits how many storms one address can create per hour', async () => {
      process.env.RATE_LIMIT_SCALE = '0.1'; // 20/hour becomes 2
      expect((await createStorm({ httpMethod: 'POST', headers: ip(1) })).statusCode).toBe(200);
      expect((await createStorm({ httpMethod: 'POST', headers: ip(1) })).statusCode).toBe(200);
      const blocked = await createStorm({ httpMethod: 'POST', headers: ip(1) });
      expect(blocked.statusCode).toBe(429);
      expect(JSON.parse(blocked.body).error).toContain('Too many requests');
      expect((await createStorm({ httpMethod: 'POST', headers: ip(2) })).statusCode).toBe(200);
    });

    it('is not limited when the caller address is unknown (local development)', async () => {
      process.env.RATE_LIMIT_SCALE = '0.0001';
      for (let i = 0; i < 4; i++) expect((await createStorm({ httpMethod: 'POST' })).statusCode).toBe(200);
    });
  });

  describe('voting', () => {
    async function liveStorm() {
      const storm = await newStorm();
      const q = JSON.parse((await addQuestion(storm.adminKey, {})).body).id;
      await adminStorm({ httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey: storm.adminKey, status: 'active', currentQuestionId: q }) });
      return { ...storm, q };
    }
    const castVote = (storm, deviceId, headers = {}, value = 0) => vote({
      httpMethod: 'POST', headers, body: JSON.stringify({ stormCode: storm.stormCode, questionId: storm.q, deviceId, value }),
    });

    it('rejects device ids that are not short plain identifiers', async () => {
      const storm = await liveStorm();
      for (const bad of ['has space', 'x'.repeat(101), 'semi;colon', '<script>', 123, ['a']]) {
        const res = await castVote(storm, bad);
        expect(res.statusCode).toBe(400);
      }
      expect((await castVote(storm, 'abc-123_XYZ')).statusCode).toBe(200);
      expect((await castVote(storm, 'a'.repeat(100), {}, 1)).statusCode).toBe(200);
    });

    it('limits how fast one device can send votes', async () => {
      const storm = await liveStorm();
      let blocked = null;
      for (let i = 0; i < 32; i++) {
        const res = await castVote(storm, 'busy-device', ip(5), i % 2);
        if (res.statusCode === 429) { blocked = i; break; }
      }
      expect(blocked).toBe(30); // the 31st request in a minute
      expect((await castVote(storm, 'other-device', ip(5))).statusCode).toBe(200);
    });

    it('limits how fast one address can send votes', async () => {
      const storm = await liveStorm();
      process.env.RATE_LIMIT_SCALE = '0.0015'; // 2000/min becomes 3/min per address
      for (let i = 0; i < 3; i++) expect((await castVote(storm, `dev-${i}`, ip(7))).statusCode).toBe(200);
      expect((await castVote(storm, 'dev-3', ip(7))).statusCode).toBe(429);
      expect((await castVote(storm, 'dev-4', ip(8))).statusCode).toBe(200);
    });
  });

  describe('question input', () => {
    it('accepts a normal question', async () => {
      const storm = await newStorm();
      expect((await addQuestion(storm.adminKey, {})).statusCode).toBe(200);
      expect((await addQuestion(storm.adminKey, { type: 'rating', options: undefined, scaleMin: 1, scaleMax: 10 })).statusCode).toBe(200);
    });

    it('rejects a missing, blank or over-long prompt', async () => {
      const storm = await newStorm();
      for (const prompt of [undefined, '', '   ', 'x'.repeat(MAX_PROMPT_LENGTH + 1)]) {
        const res = await addQuestion(storm.adminKey, { prompt });
        expect(res.statusCode).toBe(400);
      }
      expect((await addQuestion(storm.adminKey, { prompt: 'x'.repeat(MAX_PROMPT_LENGTH) })).statusCode).toBe(200);
    });

    it('rejects choices with too few, too many or over-long options', async () => {
      const storm = await newStorm();
      expect((await addQuestion(storm.adminKey, { options: ['only one'] })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { options: undefined })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`) })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { options: ['ok', 'x'.repeat(MAX_OPTION_LENGTH + 1)] })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { options: Array.from({ length: MAX_OPTIONS }, (_, i) => `o${i}`) })).statusCode).toBe(200);
    });

    it('rejects an unknown type and unreasonable rating scales', async () => {
      const storm = await newStorm();
      expect((await addQuestion(storm.adminKey, { type: 'essay' })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { type: 'rating', scaleMin: 5, scaleMax: 5 })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { type: 'rating', scaleMin: 1, scaleMax: MAX_SCALE_VALUES + 1 })).statusCode).toBe(400);
      expect((await addQuestion(storm.adminKey, { type: 'rating', scaleMin: 1, scaleMax: MAX_SCALE_VALUES })).statusCode).toBe(200);
    });

    it('applies the same rules when a question is edited', async () => {
      const storm = await newStorm();
      const id = JSON.parse((await addQuestion(storm.adminKey, {})).body).id;
      const edit = (fields) => adminQuestions({
        httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey: storm.adminKey, questionId: id, edit: { type: 'choice', prompt: 'Q', options: ['A', 'B'], ...fields } }),
      });
      expect((await edit({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) })).statusCode).toBe(400);
      expect((await edit({ options: ['A', 'y'.repeat(MAX_OPTION_LENGTH + 1)] })).statusCode).toBe(400);
      expect((await edit({ prompt: 'Better' })).statusCode).toBe(200);
    });

    it('limits how fast questions can be added from one address', async () => {
      const storm = await newStorm();
      process.env.RATE_LIMIT_SCALE = '0.025'; // 120/min becomes 3/min
      for (let i = 0; i < 3; i++) expect((await addQuestion(storm.adminKey, { prompt: `q${i}` }, ip(20))).statusCode).toBe(200);
      expect((await addQuestion(storm.adminKey, { prompt: 'q3' }, ip(20))).statusCode).toBe(429);
    });
  });

  describe('production database guard', () => {
    const saved = { lambda: process.env.AWS_LAMBDA_FUNCTION_NAME, nodeEnv: process.env.NODE_ENV, dev: process.env.NETLIFY_DEV };
    afterEach(() => {
      if (saved.lambda === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME; else process.env.AWS_LAMBDA_FUNCTION_NAME = saved.lambda;
      process.env.NODE_ENV = saved.nodeEnv;
      if (saved.dev === undefined) delete process.env.NETLIFY_DEV; else process.env.NETLIFY_DEV = saved.dev;
    });

    it('refuses to use a local file when running hosted without a remote database', () => {
      delete process.env.TURSO_DATABASE_URL;
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
      expect(() => getDbUrl()).toThrow('TURSO_DATABASE_URL is not set');
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      process.env.NODE_ENV = 'production';
      expect(() => getDbUrl()).toThrow('TURSO_DATABASE_URL is not set');
    });

    it('does not mistake `netlify dev`, which imitates the hosted runtime, for production', () => {
      delete process.env.TURSO_DATABASE_URL;
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
      process.env.NETLIFY_DEV = 'true';
      process.env.NODE_ENV = 'development';
      expect(getDbUrl()).toBe('file:./data/local-dev.db');
    });

    it('uses the configured database when hosted, and the local file in development', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
      expect(getDbUrl()).toBe(process.env.TURSO_DATABASE_URL);
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      process.env.NODE_ENV = 'test';
      delete process.env.TURSO_DATABASE_URL;
      expect(getDbUrl()).toBe('file:./data/local-dev.db');
    });
  });

  describe('cleanup', () => {
    it('removes a storm with many questions and votes in one go', async () => {
      const storm = await newStorm();
      const db = createDb();
      await initSchema(db);
      for (let i = 0; i < 15; i++) {
        const id = JSON.parse((await addQuestion(storm.adminKey, { prompt: `q${i}` })).body).id;
        await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [id, 'd1', '0', Date.now()] });
      }
      await deleteStormCascade(db, storm.stormCode);
      for (const table of ['storms', 'questions', 'votes']) {
        expect(Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n)).toBe(0);
      }
    });

    it('resets every vote in a storm with one request, leaving the questions alone', async () => {
      const storm = await newStorm();
      const db = createDb();
      for (let i = 0; i < 4; i++) {
        const id = JSON.parse((await addQuestion(storm.adminKey, { prompt: `q${i}` })).body).id;
        await db.execute({ sql: 'INSERT INTO votes (question_id, device_id, value, created_at) VALUES (?, ?, ?, ?)', args: [id, 'd1', '0', Date.now()] });
      }
      const res = await adminStorm({ httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey: storm.adminKey, action: 'reset' }) });
      expect(res.statusCode).toBe(200);
      expect(Number((await db.execute('SELECT COUNT(*) AS n FROM votes')).rows[0].n)).toBe(0);
      expect(Number((await db.execute('SELECT COUNT(*) AS n FROM questions')).rows[0].n)).toBe(4);
    });
  });

  describe('response headers', () => {
    it('are not cached and not sniffable', async () => {
      const res = await createStorm({ httpMethod: 'POST', headers: {} });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
