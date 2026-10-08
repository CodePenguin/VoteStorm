import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAdminSecret } from '../../src/lib/adminKeys';
import { signedApi } from '../../src/lib/adminRequest';
import { verifyAdmin } from '../../lib/adminAuth.js';
import { createDb, initSchema } from '../../lib/db.js';
import { insertStorm, parseNewCredentials } from '../../lib/storms.js';

// The real browser code against the real server code, with nothing mocked between them but the network. This runs in
// the Node environment, where the browser code's `crypto.subtle` is Node's own global WebCrypto (Node 20 and later),
// the same implementation the browser tests stub in. Only `fetch` is replaced, to capture what would be sent.

const license = { id: 'anonymous', name: 'Anonymous', tier: 'anonymous', expiresAt: null, stormInactivityHours: 24 };
const fetchMock = vi.fn();

// What Netlify hands a function: lower-cased header names, the method, and the body as sent.
const asEvent = (call) => {
  const [, init] = fetchMock.mock.calls[call];
  return {
    httpMethod: init.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: init.body ?? null,
  };
};

describe('browser signing against server verification', () => {
  let db, session, stormCode;

  beforeEach(async () => {
    process.env.TURSO_DATABASE_URL = `file:${path.join(mkdtempSync(path.join(tmpdir(), 'votestorm-test-')), 'test.db')}`;
    db = createDb();
    await initSchema(db);
    const made = await generateAdminSecret();
    const credentials = parseNewCredentials({ publicKey: made.publicKey, resultsKeyHash: made.resultsKeyHash });
    expect(credentials.error).toBeUndefined();
    ({ stormCode } = await insertStorm(db, license, credentials));
    session = { stormCode, secret: made.secret };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TURSO_DATABASE_URL;
  });

  it('accepts a GET signed by signedApi', async () => {
    await signedApi(session, 'admin-storm');
    const event = asEvent(0);
    expect(event.httpMethod).toBe('GET');
    const result = await verifyAdmin(event, db, 'admin-storm');
    expect(result.storm.storm_code).toBe(stormCode);
  });

  it('accepts a PATCH with a body signed by signedApi, and rejects the same request with the body changed', async () => {
    await signedApi(session, 'admin-storm', { method: 'PATCH', body: JSON.stringify({ status: 'closed', name: 'Town hall' }) });
    const event = asEvent(0);
    expect(event.httpMethod).toBe('PATCH');
    expect(event.body).toBe('{"status":"closed","name":"Town hall"}');
    const result = await verifyAdmin(event, db, 'admin-storm');
    expect(result.storm.storm_code).toBe(stormCode);

    const tampered = await verifyAdmin({ ...event, body: JSON.stringify({ status: 'closed', name: 'Other' }) }, db, 'admin-storm');
    expect(tampered.storm).toBeUndefined();
    expect(tampered.response.statusCode).toBe(401);
  });
});
