import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verify } from 'node:crypto';
import {
  SIGNATURE_WINDOW_MS,
  canonicalText,
  parseSignatureHeader,
  parsePublicKey,
  publicKeyHash,
  isResultsKeyHash,
  verifyAdmin,
} from '../../lib/adminAuth.js';
import { createDb, initSchema } from '../../lib/db.js';
import { makeAdmin, seedStorm } from '../helpers/admin.js';

const vector = JSON.parse(readFileSync(new URL('../fixtures/admin-signature-vector.json', import.meta.url), 'utf8'));

const verifyText = (text) =>
  verify('sha256', Buffer.from(text), { key: parsePublicKey(vector.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(vector.signature, 'base64url'));

describe('canonicalText', () => {
  it('matches the shared vector', () => {
    expect(canonicalText(vector.input)).toBe(vector.canonicalText);
  });

  it('hashes the empty string when there is no body', () => {
    const lines = canonicalText({ method: 'get', functionName: 'admin-storm', stormCode: 'ABCDEFGH', ts: 1 }).split('\n');
    expect(lines[1]).toBe('GET');
    expect(lines.at(-1)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('exposes a 30 second window', () => {
    expect(SIGNATURE_WINDOW_MS).toBe(30000);
  });
});

describe('signature vector', () => {
  it('verifies with the public key', () => {
    expect(verifyText(vector.canonicalText)).toBe(true);
  });

  it('fails when one character of the text changes', () => {
    expect(verifyText(vector.canonicalText.replace('ABCDEFGH', 'ABCDEFGI'))).toBe(false);
  });
});

describe('parseSignatureHeader', () => {
  it('parses the documented shape', () => {
    expect(parseSignatureHeader('storm=ABCDEFGH, ts=1790000000000, sig=abc_-123')).toEqual({
      stormCode: 'ABCDEFGH',
      ts: 1790000000000,
      sig: 'abc_-123',
    });
  });

  it('allows no spaces and normalises a lowercase code', () => {
    expect(parseSignatureHeader('storm=abcd-efgh,ts=5,sig=xyz')).toEqual({ stormCode: 'ABCDEFGH', ts: 5, sig: 'xyz' });
  });

  it.each([
    ['missing sig', 'storm=ABCDEFGH, ts=1'],
    ['missing ts', 'storm=ABCDEFGH, sig=abc'],
    ['non-numeric ts', 'storm=ABCDEFGH, ts=abc, sig=abc'],
    ['sig with +', 'storm=ABCDEFGH, ts=1, sig=ab+c'],
    ['no storm', 'ts=1, sig=abc'],
    ['undefined', undefined],
    ['item without =', 'storm=ABCDEFGH, ts=1, sig'],
  ])('returns null for %s', (_name, value) => {
    expect(parseSignatureHeader(value)).toBeNull();
  });
});

describe('parsePublicKey', () => {
  const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

  it('returns a key for the vector', () => {
    expect(parsePublicKey(vector.publicKey)).not.toBeNull();
  });

  it('returns null for the wrong length', () => {
    expect(parsePublicKey(b64(Buffer.alloc(64, 1)))).toBeNull();
  });

  it('returns null when the first byte is 0x02', () => {
    const bytes = Buffer.from(vector.publicKey, 'base64url');
    bytes[0] = 2;
    expect(parsePublicKey(b64(bytes))).toBeNull();
  });

  it('returns null for non-base64url text and non-strings', () => {
    expect(parsePublicKey('not+base64/url=')).toBeNull();
    expect(parsePublicKey(undefined)).toBeNull();
  });

  it('returns null for a point that is not on the curve', () => {
    expect(parsePublicKey(b64(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])))).toBeNull();
  });
});

describe('publicKeyHash', () => {
  it('is 64 hex characters and stable', () => {
    const hash = publicKeyHash(vector.publicKey);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyHash(vector.publicKey)).toBe(hash);
  });
});

describe('isResultsKeyHash', () => {
  it('accepts 64 lowercase hex characters', () => {
    expect(isResultsKeyHash('a'.repeat(64))).toBe(true);
  });

  it('rejects other values', () => {
    expect(isResultsKeyHash('a'.repeat(63))).toBe(false);
    expect(isResultsKeyHash('A'.repeat(64))).toBe(false);
    expect(isResultsKeyHash(undefined)).toBe(false);
    expect(isResultsKeyHash(12)).toBe(false);
  });
});

describe('verifyAdmin', () => {
  const DENIED = { error: 'Invalid admin credentials' };
  let db, admin;
  const get = { httpMethod: 'GET', headers: {} };
  const patch = { httpMethod: 'PATCH', headers: {}, body: JSON.stringify({ title: 'x' }) };
  const denies = async (event, fn = 'admin-storm') => {
    const result = await verifyAdmin(event, db, fn);
    expect(result.response.statusCode).toBe(401);
    expect(JSON.parse(result.response.body)).toEqual(DENIED);
  };

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    db = createDb();
    await initSchema(db);
    admin = await seedStorm(db);
  });

  afterEach(() => {
    delete process.env.TURSO_DATABASE_URL;
  });

  it('accepts a correct GET', async () => {
    const result = await verifyAdmin(await admin.sign('admin-storm', get), db, 'admin-storm');
    expect(result.storm.storm_code).toBe(admin.stormCode);
  });

  it('accepts a correct PATCH with a body', async () => {
    const result = await verifyAdmin(await admin.sign('admin-storm', patch), db, 'admin-storm');
    expect(result.storm.storm_code).toBe(admin.stormCode);
  });

  it('accepts a lowercase code in the header', async () => {
    const event = await admin.sign('admin-storm', get);
    const header = event.headers['x-admin-signature'].replace(admin.stormCode, admin.stormCode.toLowerCase());
    expect(header).not.toBe(event.headers['x-admin-signature']);
    const result = await verifyAdmin({ ...event, headers: { 'x-admin-signature': header } }, db, 'admin-storm');
    expect(result.storm.storm_code).toBe(admin.stormCode);
  });

  it('rejects a tampered body', async () => {
    const event = await admin.sign('admin-storm', patch);
    await denies({ ...event, body: JSON.stringify({ title: 'y' }) });
  });

  it('rejects a changed method', async () => {
    const event = await admin.sign('admin-storm', get);
    await denies({ ...event, httpMethod: 'DELETE' });
  });

  it('rejects a different function name', async () => {
    await denies(await admin.sign('admin-storm', get), 'admin-questions');
  });

  it('rejects a different Storm code', async () => {
    // Storm B has A's public key, so only the Storm code in the signed text can tell the two apart.
    const other = await seedStorm(db, { admin_public_key: admin.publicKey, admin_key_hash: 'b'.repeat(64) });
    expect((await verifyAdmin(await admin.sign('admin-storm', get, { stormCode: other.stormCode }), db, 'admin-storm')).storm.storm_code).toBe(other.stormCode);
    const event = await admin.sign('admin-storm', get);
    const header = event.headers['x-admin-signature'].replace(admin.stormCode, other.stormCode);
    expect(header).not.toBe(event.headers['x-admin-signature']);
    await denies({ ...event, headers: { 'x-admin-signature': header } });
  });

  it('rejects an edited timestamp', async () => {
    const event = await admin.sign('admin-storm', get);
    const header = event.headers['x-admin-signature'].replace(/ts=(\d+)/, (_m, n) => `ts=${Number(n) + 1}`);
    await denies({ ...event, headers: { 'x-admin-signature': header } });
  });

  it('gives the same 401 for an unknown Storm', async () => {
    await denies(await admin.sign('admin-storm', get, { stormCode: 'ZZZZZZZZ' }));
  });

  it('gives the same 401 for a Storm with no public key', async () => {
    await db.execute({ sql: 'UPDATE storms SET admin_public_key = NULL WHERE storm_code = ?', args: [admin.stormCode] });
    await denies(await admin.sign('admin-storm', get));
  });

  it('gives the same 401 for no header and for a garbage header', async () => {
    await denies(get);
    await denies({ ...get, headers: { 'x-admin-signature': 'nonsense' } });
  });

  it('rejects a request signed by a different presenter', async () => {
    const stranger = await makeAdmin();
    await denies(await stranger.sign('admin-storm', get, { stormCode: admin.stormCode }));
  });

  it.each([-31000, 31000])('answers clock_skew with the server time for ts offset %i', async (offset) => {
    const now = Date.now();
    const result = await verifyAdmin(await admin.sign('admin-storm', get, { ts: now + offset }), db, 'admin-storm', now);
    expect(result.response.statusCode).toBe(401);
    const body = JSON.parse(result.response.body);
    expect(body.code).toBe('clock_skew');
    expect(body.serverTime).toBe(now);
  });

  it('accepts a timestamp 29 seconds old', async () => {
    const now = Date.now();
    const result = await verifyAdmin(await admin.sign('admin-storm', get, { ts: now - 29000 }), db, 'admin-storm', now);
    expect(result.storm.storm_code).toBe(admin.stormCode);
  });

  it('accepts a repeated request inside the window (replay is accepted on purpose)', async () => {
    const event = await admin.sign('admin-storm', get);
    expect((await verifyAdmin(event, db, 'admin-storm')).storm).toBeTruthy();
    expect((await verifyAdmin(event, db, 'admin-storm')).storm).toBeTruthy();
  });

  it('gives the generic 401 for a skewed timestamp with a bad signature', async () => {
    const now = Date.now();
    const event = await admin.sign('admin-storm', get, { ts: now - 60000 });
    const header = event.headers['x-admin-signature'].replace(/sig=(.)/, (_m, c) => `sig=${c === 'A' ? 'B' : 'A'}`);
    const result = await verifyAdmin({ ...event, headers: { 'x-admin-signature': header } }, db, 'admin-storm', now);
    expect(JSON.parse(result.response.body)).toEqual(DENIED);
  });
});
