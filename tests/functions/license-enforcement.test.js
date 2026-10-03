import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, initSchema } from '../../lib/db.js';
import { handler as createRoom } from '../../netlify/functions/create-room.js';
import { handler as adminRoom } from '../../netlify/functions/admin-room.js';
import { handler as adminQuestions } from '../../netlify/functions/admin-questions.js';
import { handler as vote } from '../../netlify/functions/vote.js';
import { handler as licenseStatus } from '../../netlify/functions/license-status.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';

const HOUR = 3600000;

describe('license enforcement', () => {
  let issuer;
  let restore;

  beforeAll(async () => {
    issuer = await makeIssuer();
  });

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    restore = useIssuer(issuer);
  });

  afterEach(() => {
    restore();
    delete process.env.TURSO_DATABASE_URL;
  });

  const create = async (jwt) => {
    const res = await createRoom({ httpMethod: 'POST', headers: jwt ? bearer(jwt) : {} });
    return { res, body: JSON.parse(res.body) };
  };
  const addQuestion = (adminKey, jwt, prompt = 'Q') => adminQuestions({
    httpMethod: 'POST', headers: jwt ? bearer(jwt) : {},
    body: JSON.stringify({ adminKey, type: 'choice', prompt, options: ['A', 'B'] }),
  });
  const roomRow = async (roomCode) => (await createDb().execute({ sql: 'SELECT * FROM rooms WHERE room_code = ?', args: [roomCode] })).rows[0];
  const activate = (adminKey, questionId) => adminRoom({
    httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
  });
  const castVote = (roomCode, questionId, deviceId, value = 0) => vote({
    httpMethod: 'POST', body: JSON.stringify({ roomCode, questionId, deviceId, value }),
  });

  describe('creating rooms', () => {
    it('gives an anonymous room the 24-hour window and no owner', async () => {
      const { body } = await create();
      const row = await roomRow(body.roomCode);
      expect(Number(row.inactivity_hours)).toBe(24);
      expect(row.license_id).toBeNull();
      expect(JSON.parse(row.license_json)).toMatchObject({ tier: 'anonymous' });
    });

    it('stores the license on the room, including its own inactivity window', async () => {
      const jwt = await issuer.sign({ name: 'Acme', roomInactivityHours: 168, maxQuestionsPerRoom: 3 }, { sub: 'acme' });
      const { res, body } = await create(jwt);
      expect(res.statusCode).toBe(200);
      const row = await roomRow(body.roomCode);
      expect(Number(row.inactivity_hours)).toBe(168);
      expect(row.license_id).toBe('acme');
      expect(JSON.parse(row.license_json)).toMatchObject({ name: 'Acme', maxQuestionsPerRoom: 3 });
    });

    it('refuses an invalid or expired license and creates nothing', async () => {
      for (const jwt of ['garbage', await issuer.sign({}, { expiresIn: '-1h' })]) {
        const { res, body } = await create(jwt);
        expect(res.statusCode).toBe(401);
        expect(body.code).toBe('license_invalid');
      }
      const db = createDb();
      await initSchema(db);
      const count = await db.execute('SELECT COUNT(*) AS n FROM rooms');
      expect(Number(count.rows[0].n)).toBe(0);
    });

    it('limits how many rooms one license can have, and frees a slot when a room goes', async () => {
      const jwt = await issuer.sign({ maxActiveRooms: 2 }, { sub: 'limited' });
      const first = (await create(jwt)).body;
      await create(jwt);
      const third = await create(jwt);
      expect(third.res.statusCode).toBe(403);
      expect(third.body.code).toBe('room_limit');
      expect(third.body.error).toContain('2 active rooms');

      await adminRoom({ httpMethod: 'DELETE', headers: bearer(jwt), body: JSON.stringify({ adminKey: first.adminKey }) });
      expect((await create(jwt)).res.statusCode).toBe(200);

      const other = await issuer.sign({ maxActiveRooms: 2 }, { sub: 'someone-else' });
      expect((await create(other)).res.statusCode).toBe(200);
    });

    it('does not apply a room limit to the anonymous tier, which has no identity to count against', async () => {
      process.env.ANONYMOUS_LICENSE_JSON = JSON.stringify({ maxActiveRooms: 1 });
      expect((await create()).res.statusCode).toBe(200);
      expect((await create()).res.statusCode).toBe(200);
    });
  });

  describe('questions per room', () => {
    it('stops adding questions at the license limit but still allows edits and deletes', async () => {
      const jwt = await issuer.sign({ maxQuestionsPerRoom: 2 });
      const { body } = await create(jwt);
      const q1 = JSON.parse((await addQuestion(body.adminKey, jwt, 'one')).body).id;
      await addQuestion(body.adminKey, jwt, 'two');
      const third = await addQuestion(body.adminKey, jwt, 'three');
      expect(third.statusCode).toBe(403);
      expect(JSON.parse(third.body)).toMatchObject({ code: 'question_limit' });
      expect(JSON.parse(third.body).error).toContain('2 questions');

      const edit = await adminQuestions({
        httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey: body.adminKey, questionId: q1, edit: { type: 'choice', prompt: 'renamed', options: ['A', 'B'] } }),
      });
      expect(edit.statusCode).toBe(200);
      await adminQuestions({ httpMethod: 'DELETE', headers: {}, body: JSON.stringify({ adminKey: body.adminKey, questionId: q1 }) });
      expect((await addQuestion(body.adminKey, jwt, 'again')).statusCode).toBe(200);
    });

    it('keeps applying the limit when the presenter page does not resend the license (it is stored on the room)', async () => {
      const jwt = await issuer.sign({ maxQuestionsPerRoom: 1 });
      const { body } = await create(jwt);
      expect((await addQuestion(body.adminKey, jwt)).statusCode).toBe(200);
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(403);
    });

    it('takes the anonymous limit from configuration', async () => {
      process.env.ANONYMOUS_LICENSE_JSON = JSON.stringify({ maxQuestionsPerRoom: 1 });
      const { body } = await create();
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(200);
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(403);
    });

    it('is unlimited when the license sets no limit', async () => {
      const { body } = await create(await issuer.sign({ name: 'Open' }));
      for (let i = 0; i < 6; i++) expect((await addQuestion(body.adminKey, null, `q${i}`)).statusCode).toBe(200);
    });
  });

  describe('audience per room', () => {
    async function liveRoom(limits) {
      const jwt = await issuer.sign(limits);
      const { body } = await create(jwt);
      const q1 = JSON.parse((await addQuestion(body.adminKey, null, 'one')).body).id;
      const q2 = JSON.parse((await addQuestion(body.adminKey, null, 'two')).body).id;
      await activate(body.adminKey, q1);
      return { ...body, q1, q2 };
    }

    it('lets the first N devices vote and turns the next one away', async () => {
      const room = await liveRoom({ maxAudiencePerRoom: 2 });
      expect((await castVote(room.roomCode, room.q1, 'd1')).statusCode).toBe(200);
      expect((await castVote(room.roomCode, room.q1, 'd2')).statusCode).toBe(200);
      const full = await castVote(room.roomCode, room.q1, 'd3');
      expect(full.statusCode).toBe(403);
      expect(JSON.parse(full.body)).toMatchObject({ code: 'audience_full' });
    });

    it('lets devices already in the audience keep voting, changing answers, and answering later questions', async () => {
      const room = await liveRoom({ maxAudiencePerRoom: 2 });
      await castVote(room.roomCode, room.q1, 'd1');
      await castVote(room.roomCode, room.q1, 'd2');
      expect((await castVote(room.roomCode, room.q1, 'd1', 1)).statusCode).toBe(200);
      await activate(room.adminKey, room.q2);
      expect((await castVote(room.roomCode, room.q2, 'd2')).statusCode).toBe(200);
      expect((await castVote(room.roomCode, room.q2, 'd3')).statusCode).toBe(403);
    });

    it('is not limited when the license has no audience limit', async () => {
      const room = await liveRoom({ name: 'Open' });
      for (let i = 0; i < 8; i++) expect((await castVote(room.roomCode, room.q1, `d${i}`)).statusCode).toBe(200);
    });
  });

  describe('expiry', () => {
    it('lets an anonymous room lapse after 24 hours of inactivity, and removes it when next opened', async () => {
      const { body } = await create();
      await createDb().execute({ sql: 'UPDATE rooms SET last_activity_at = ? WHERE room_code = ?', args: [Date.now() - 25 * HOUR, body.roomCode] });
      const res = await adminRoom({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(401);
      expect(await roomRow(body.roomCode)).toBeUndefined();
    });

    it('keeps a licensed room for as long as its license allows', async () => {
      const { body } = await create(await issuer.sign({ roomInactivityHours: 168 }));
      await createDb().execute({ sql: 'UPDATE rooms SET last_activity_at = ? WHERE room_code = ?', args: [Date.now() - 100 * HOUR, body.roomCode] });
      const res = await adminRoom({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(200);
    });

    it('treats audience votes as activity so a busy room does not expire', async () => {
      const { body } = await create();
      const q = JSON.parse((await addQuestion(body.adminKey, null)).body).id;
      await activate(body.adminKey, q);
      await createDb().execute({ sql: 'UPDATE rooms SET last_activity_at = ? WHERE room_code = ?', args: [Date.now() - 23 * HOUR, body.roomCode] });
      await castVote(body.roomCode, q, 'd1');
      expect(Number((await roomRow(body.roomCode)).last_activity_at)).toBeGreaterThan(Date.now() - 60000);
    });

    it('hides an expired room from the audience too', async () => {
      const { body } = await create();
      await createDb().execute({ sql: 'UPDATE rooms SET last_activity_at = ? WHERE room_code = ?', args: [Date.now() - 25 * HOUR, body.roomCode] });
      const res = await castVote(body.roomCode, 1, 'd1');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('presenting a license later', () => {
    it('reports the license in effect on the presenter page', async () => {
      const { body } = await create();
      const anon = JSON.parse((await adminRoom({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } })).body);
      expect(anon.license).toMatchObject({ tier: 'anonymous', limits: { roomInactivityHours: 24 } });

      const jwt = await issuer.sign({ name: 'Upgrade', roomInactivityHours: 96, maxAudiencePerRoom: 10 });
      const upgraded = JSON.parse((await adminRoom({ httpMethod: 'GET', headers: bearer(jwt), queryStringParameters: { adminKey: body.adminKey } })).body);
      expect(upgraded.license).toMatchObject({ tier: 'licensed', name: 'Upgrade', limits: { roomInactivityHours: 96, maxAudiencePerRoom: 10 } });
      const row = await roomRow(body.roomCode);
      expect(Number(row.inactivity_hours)).toBe(96);
      expect(JSON.parse(row.license_json)).toMatchObject({ maxAudiencePerRoom: 10 });
    });

    it('ignores an invalid license on a presenter page instead of locking the presenter out', async () => {
      const { body } = await create(await issuer.sign({ roomInactivityHours: 48 }));
      const res = await adminRoom({ httpMethod: 'GET', headers: bearer('junk'), queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).license.limits.roomInactivityHours).toBe(48);
    });
  });

  describe('license-status', () => {
    const status = (headers) => licenseStatus({ httpMethod: 'GET', headers });

    it('reports the anonymous tier with its limits when no license is presented', async () => {
      const res = await status({});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ tier: 'anonymous', name: null, limits: { roomInactivityHours: 24 } });
    });

    it('reports a valid license, and rejects an invalid one with a code the page can act on', async () => {
      const ok = JSON.parse((await status(bearer(await issuer.sign({ name: 'Zed', maxActiveRooms: 4 })))).body);
      expect(ok).toMatchObject({ tier: 'licensed', name: 'Zed', limits: { maxActiveRooms: 4 } });
      const bad = await status(bearer('nope'));
      expect(bad.statusCode).toBe(401);
      expect(JSON.parse(bad.body).code).toBe('license_invalid');
    });

    it('only answers GET', async () => {
      expect((await licenseStatus({ httpMethod: 'POST', headers: {} })).statusCode).toBe(405);
    });
  });
});
