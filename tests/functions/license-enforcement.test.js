import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(),
}));

import { createDb, initSchema } from '../../lib/db.js';
import { handler as createStorm } from '../../netlify/functions/create-storm.js';
import { handler as adminStorm } from '../../netlify/functions/admin-storm.js';
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
    const res = await createStorm({ httpMethod: 'POST', headers: jwt ? bearer(jwt) : {} });
    return { res, body: JSON.parse(res.body) };
  };
  const addQuestion = (adminKey, jwt, prompt = 'Q') => adminQuestions({
    httpMethod: 'POST', headers: jwt ? bearer(jwt) : {},
    body: JSON.stringify({ adminKey, type: 'choice', prompt, options: ['A', 'B'] }),
  });
  const stormRow = async (stormCode) => (await createDb().execute({ sql: 'SELECT * FROM storms WHERE storm_code = ?', args: [stormCode] })).rows[0];
  const activate = (adminKey, questionId) => adminStorm({
    httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ adminKey, status: 'active', currentQuestionId: questionId }),
  });
  const castVote = (stormCode, questionId, deviceId, value = 0) => vote({
    httpMethod: 'POST', body: JSON.stringify({ stormCode, questionId, deviceId, value }),
  });

  describe('creating storms', () => {
    it('gives an anonymous storm the 24-hour window and no owner', async () => {
      const { body } = await create();
      const row = await stormRow(body.stormCode);
      expect(Number(row.inactivity_hours)).toBe(24);
      expect(row.license_id).toBeNull();
      expect(JSON.parse(row.license_json)).toMatchObject({ tier: 'anonymous' });
    });

    it('stores the license on the storm, including its own inactivity window', async () => {
      const jwt = await issuer.sign({ name: 'Acme', stormInactivityHours: 168, maxQuestionsPerStorm: 3 }, { sub: 'acme' });
      const { res, body } = await create(jwt);
      expect(res.statusCode).toBe(200);
      const row = await stormRow(body.stormCode);
      expect(Number(row.inactivity_hours)).toBe(168);
      expect(row.license_id).toBe('acme');
      expect(JSON.parse(row.license_json)).toMatchObject({ name: 'Acme', maxQuestionsPerStorm: 3 });
    });

    it('refuses an invalid or expired license and creates nothing', async () => {
      for (const jwt of ['garbage', await issuer.sign({}, { expiresIn: '-1h' })]) {
        const { res, body } = await create(jwt);
        expect(res.statusCode).toBe(401);
        expect(body.code).toBe('license_invalid');
      }
      const db = createDb();
      await initSchema(db);
      const count = await db.execute('SELECT COUNT(*) AS n FROM storms');
      expect(Number(count.rows[0].n)).toBe(0);
    });

    it('limits how many storms one license can have, and frees a slot when a storm goes', async () => {
      const jwt = await issuer.sign({ maxActiveStorms: 2 }, { sub: 'limited' });
      const first = (await create(jwt)).body;
      await create(jwt);
      const third = await create(jwt);
      expect(third.res.statusCode).toBe(403);
      expect(third.body.code).toBe('storm_limit');
      expect(third.body.error).toContain('2 active Storms');

      await adminStorm({ httpMethod: 'DELETE', headers: bearer(jwt), body: JSON.stringify({ adminKey: first.adminKey }) });
      expect((await create(jwt)).res.statusCode).toBe(200);

      const other = await issuer.sign({ maxActiveStorms: 2 }, { sub: 'someone-else' });
      expect((await create(other)).res.statusCode).toBe(200);
    });

    it('applies the storm limit to the anonymous tier too, as a cap on anonymous storms across the whole server', async () => {
      process.env.ANONYMOUS_LICENSE_JWT = await issuer.sign({ maxActiveStorms: 2 }, { sub: 'anonymous' });
      expect((await create()).res.statusCode).toBe(200);
      const second = await create();
      expect(second.res.statusCode).toBe(200);
      const third = await create();
      expect(third.res.statusCode).toBe(403);
      expect(third.body.code).toBe('storm_limit');
      expect(third.body.error).toContain('This server is at its limit of 2 active Storms');
      expect(third.body.error).not.toContain('Your license');

      await adminStorm({ httpMethod: 'DELETE', headers: {}, body: JSON.stringify({ adminKey: second.body.adminKey }) });
      expect((await create()).res.statusCode).toBe(200);
    });

    it('counts anonymous and licensed storms separately, so one cannot use up the other\'s allowance', async () => {
      process.env.ANONYMOUS_LICENSE_JWT = await issuer.sign({ maxActiveStorms: 1 }, { sub: 'anonymous' });
      const jwt = await issuer.sign({ maxActiveStorms: 1 }, { sub: 'paying-customer' });
      expect((await create()).res.statusCode).toBe(200);
      expect((await create()).res.statusCode).toBe(403);
      expect((await create(jwt)).res.statusCode).toBe(200);
      expect((await create(jwt)).res.statusCode).toBe(403);
    });

    it('counts a storm against the license that created it, even after another license is presented on it', async () => {
      const mine = await issuer.sign({ maxActiveStorms: 1 }, { sub: 'creator' });
      const { body } = await create(mine);
      const other = await issuer.sign({ stormInactivityHours: 48 }, { sub: 'someone-else' });
      await adminStorm({ httpMethod: 'GET', headers: bearer(other), queryStringParameters: { adminKey: body.adminKey } });
      expect((await create(mine)).res.statusCode).toBe(403);
    });

    it('frees the storm for the license once the storm has expired', async () => {
      process.env.ANONYMOUS_LICENSE_JWT = await issuer.sign({ maxActiveStorms: 1 }, { sub: 'anonymous' });
      const { body } = await create();
      expect((await create()).res.statusCode).toBe(403);
      await createDb().execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 25 * HOUR, body.stormCode] });
      expect((await create()).res.statusCode).toBe(200);
    });

    it('does not limit storms when the license sets no storm limit', async () => {
      for (let i = 0; i < 5; i++) expect((await create()).res.statusCode).toBe(200);
    });
  });

  describe('who created a storm', () => {
    it('records the anonymous tier as the creator of an anonymous storm', async () => {
      const { body } = await create();
      const row = await stormRow(body.stormCode);
      expect(row.created_by_license_id).toBe('anonymous');
      expect(row.created_by_license_name).toBe('Anonymous');
    });

    it('records the license that created a licensed storm, by id and name', async () => {
      const { body } = await create(await issuer.sign({ name: 'Acme Training' }, { sub: 'acme-42' }));
      const row = await stormRow(body.stormCode);
      expect(row.created_by_license_id).toBe('acme-42');
      expect(row.created_by_license_name).toBe('Acme Training');
    });

    it('keeps the creator when someone else later presents their license on the storm', async () => {
      const { body } = await create(await issuer.sign({ name: 'Creator' }, { sub: 'creator-1' }));
      const other = await issuer.sign({ name: 'Other', stormInactivityHours: 96 }, { sub: 'other-2' });
      await adminStorm({ httpMethod: 'GET', headers: bearer(other), queryStringParameters: { adminKey: body.adminKey } });
      const row = await stormRow(body.stormCode);
      expect(row.license_id).toBe('other-2'); // the license the storm runs under now
      expect(row.created_by_license_id).toBe('creator-1'); // who made it
      expect(row.created_by_license_name).toBe('Creator');
    });

    it('can be summarised with the query in the documentation', async () => {
      await create();
      await create();
      await create(await issuer.sign({ name: 'Acme Training' }, { sub: 'acme-42' }));
      const rows = (await createDb().execute(`SELECT created_by_license_id, created_by_license_name, COUNT(*) AS storms, MAX(created_at) AS latest
        FROM storms GROUP BY created_by_license_id ORDER BY storms DESC`)).rows;
      expect(rows.map((r) => [r.created_by_license_id, r.created_by_license_name, Number(r.storms)])).toEqual([
        ['anonymous', 'Anonymous', 2],
        ['acme-42', 'Acme Training', 1],
      ]);
    });

    it('does not count anonymous storms against any license', async () => {
      const jwt = await issuer.sign({ maxActiveStorms: 1 }, { sub: 'solo' });
      await create();
      await create();
      expect((await create(jwt)).res.statusCode).toBe(200);
    });
  });

  describe('questions per storm', () => {
    it('stops adding questions at the license limit but still allows edits and deletes', async () => {
      const jwt = await issuer.sign({ maxQuestionsPerStorm: 2 });
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

    it('keeps applying the limit when the presenter page does not resend the license (it is stored on the storm)', async () => {
      const jwt = await issuer.sign({ maxQuestionsPerStorm: 1 });
      const { body } = await create(jwt);
      expect((await addQuestion(body.adminKey, jwt)).statusCode).toBe(200);
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(403);
    });

    it('takes the anonymous limit from configuration', async () => {
      process.env.ANONYMOUS_LICENSE_JWT = await issuer.sign({ maxQuestionsPerStorm: 1 }, { sub: 'anything' });
      const { body } = await create();
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(200);
      expect((await addQuestion(body.adminKey, null)).statusCode).toBe(403);
    });

    it('is unlimited when the license sets no limit', async () => {
      const { body } = await create(await issuer.sign({ name: 'Open' }));
      for (let i = 0; i < 6; i++) expect((await addQuestion(body.adminKey, null, `q${i}`)).statusCode).toBe(200);
    });
  });

  describe('audience per storm', () => {
    async function liveStorm(limits) {
      const jwt = await issuer.sign(limits);
      const { body } = await create(jwt);
      const q1 = JSON.parse((await addQuestion(body.adminKey, null, 'one')).body).id;
      const q2 = JSON.parse((await addQuestion(body.adminKey, null, 'two')).body).id;
      await activate(body.adminKey, q1);
      return { ...body, q1, q2 };
    }

    it('lets the first N devices vote and turns the next one away', async () => {
      const storm = await liveStorm({ maxAudiencePerStorm: 2 });
      expect((await castVote(storm.stormCode, storm.q1, 'd1')).statusCode).toBe(200);
      expect((await castVote(storm.stormCode, storm.q1, 'd2')).statusCode).toBe(200);
      const full = await castVote(storm.stormCode, storm.q1, 'd3');
      expect(full.statusCode).toBe(403);
      expect(JSON.parse(full.body)).toMatchObject({ code: 'audience_full' });
    });

    it('lets devices already in the audience keep voting, changing answers, and answering later questions', async () => {
      const storm = await liveStorm({ maxAudiencePerStorm: 2 });
      await castVote(storm.stormCode, storm.q1, 'd1');
      await castVote(storm.stormCode, storm.q1, 'd2');
      expect((await castVote(storm.stormCode, storm.q1, 'd1', 1)).statusCode).toBe(200);
      await activate(storm.adminKey, storm.q2);
      expect((await castVote(storm.stormCode, storm.q2, 'd2')).statusCode).toBe(200);
      expect((await castVote(storm.stormCode, storm.q2, 'd3')).statusCode).toBe(403);
    });

    it('is not limited when the license has no audience limit', async () => {
      const storm = await liveStorm({ name: 'Open' });
      for (let i = 0; i < 8; i++) expect((await castVote(storm.stormCode, storm.q1, `d${i}`)).statusCode).toBe(200);
    });
  });

  describe('expiry', () => {
    it('lets an anonymous storm lapse after 24 hours of inactivity, and removes it when next opened', async () => {
      const { body } = await create();
      await createDb().execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 25 * HOUR, body.stormCode] });
      const res = await adminStorm({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(401);
      expect(await stormRow(body.stormCode)).toBeUndefined();
    });

    it('keeps a licensed storm for as long as its license allows', async () => {
      const { body } = await create(await issuer.sign({ stormInactivityHours: 168 }));
      await createDb().execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 100 * HOUR, body.stormCode] });
      const res = await adminStorm({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(200);
    });

    it('treats audience votes as activity so a busy storm does not expire', async () => {
      const { body } = await create();
      const q = JSON.parse((await addQuestion(body.adminKey, null)).body).id;
      await activate(body.adminKey, q);
      await createDb().execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 23 * HOUR, body.stormCode] });
      await castVote(body.stormCode, q, 'd1');
      expect(Number((await stormRow(body.stormCode)).last_activity_at)).toBeGreaterThan(Date.now() - 60000);
    });

    it('hides an expired storm from the audience too', async () => {
      const { body } = await create();
      await createDb().execute({ sql: 'UPDATE storms SET last_activity_at = ? WHERE storm_code = ?', args: [Date.now() - 25 * HOUR, body.stormCode] });
      const res = await castVote(body.stormCode, 1, 'd1');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('presenting a license later', () => {
    it('reports the license in effect on the presenter page', async () => {
      const { body } = await create();
      const anon = JSON.parse((await adminStorm({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } })).body);
      expect(anon.license).toMatchObject({ tier: 'anonymous', limits: { stormInactivityHours: 24 } });

      const jwt = await issuer.sign({ name: 'Upgrade', stormInactivityHours: 96, maxAudiencePerStorm: 10 });
      const upgraded = JSON.parse((await adminStorm({ httpMethod: 'GET', headers: bearer(jwt), queryStringParameters: { adminKey: body.adminKey } })).body);
      expect(upgraded.license).toMatchObject({ tier: 'licensed', name: 'Upgrade', limits: { stormInactivityHours: 96, maxAudiencePerStorm: 10 } });
      const row = await stormRow(body.stormCode);
      expect(Number(row.inactivity_hours)).toBe(96);
      expect(JSON.parse(row.license_json)).toMatchObject({ maxAudiencePerStorm: 10 });
    });

    it('ignores an invalid license on a presenter page instead of locking the presenter out', async () => {
      const { body } = await create(await issuer.sign({ stormInactivityHours: 48 }));
      const res = await adminStorm({ httpMethod: 'GET', headers: bearer('junk'), queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).license.limits.stormInactivityHours).toBe(48);
    });
  });

  describe('a misconfigured anonymous license', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const expectMisconfigured = (res, body) => {
      expect(res.statusCode).toBe(500);
      expect(body.code).toBe('misconfigured');
      expect(body.error).not.toContain('ANONYMOUS_LICENSE_JWT');
    };

    it('stops storms being created, with a clear server error and the real reason only in the log', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.ANONYMOUS_LICENSE_JWT = await issuer.sign({}, { expiresIn: '-1h' });
      const { res, body } = await create();
      expectMisconfigured(res, body);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ANONYMOUS_LICENSE_JWT is not usable'));
      const db = createDb();
      await initSchema(db);
      expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(0);
    });

    it('does the same when no anonymous license has been set at all, even locally', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env.ANONYMOUS_LICENSE_JWT;
      process.env.NODE_ENV = 'development';
      const { res, body } = await create();
      expectMisconfigured(res, body);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ANONYMOUS_LICENSE_JWT is not set'));
    });

    it('is also reported by license-status, but a presented valid license still works', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env.ANONYMOUS_LICENSE_JWT;
      const missing = await licenseStatus({ httpMethod: 'GET', headers: {} });
      expectMisconfigured(missing, JSON.parse(missing.body));
      const jwt = await issuer.sign({ name: 'Own license' });
      const res = await licenseStatus({ httpMethod: 'GET', headers: bearer(jwt) });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe('Own license');
    });

    it('does not affect storms that already exist', async () => {
      const { body } = await create();
      process.env.ANONYMOUS_LICENSE_JWT = 'junk';
      const res = await adminStorm({ httpMethod: 'GET', headers: {}, queryStringParameters: { adminKey: body.adminKey } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('license-status', () => {
    const status = (headers) => licenseStatus({ httpMethod: 'GET', headers });

    it('reports the anonymous tier with its limits when no license is presented', async () => {
      const res = await status({});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ tier: 'anonymous', name: 'Anonymous', limits: { stormInactivityHours: 24 } });
    });

    it('reports a valid license, and rejects an invalid one with a code the page can act on', async () => {
      const ok = JSON.parse((await status(bearer(await issuer.sign({ name: 'Zed', maxActiveStorms: 4 })))).body);
      expect(ok).toMatchObject({ tier: 'licensed', name: 'Zed', limits: { maxActiveStorms: 4 } });
      const bad = await status(bearer('nope'));
      expect(bad.statusCode).toBe(401);
      expect(JSON.parse(bad.body).code).toBe('license_invalid');
    });

    it('only answers GET', async () => {
      expect((await licenseStatus({ httpMethod: 'POST', headers: {} })).statusCode).toBe(405);
    });
  });
});
