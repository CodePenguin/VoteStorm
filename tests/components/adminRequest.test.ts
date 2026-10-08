// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { webcrypto, createPublicKey, verify } from 'node:crypto';
import { ApiError } from '@/api';
import { generateAdminSecret, describeSecret, fromBase64Url } from '@/lib/adminKeys';
import { canonicalText, signedApi, resetClockOffset, type AdminSession } from '@/lib/adminRequest';
import { activity, resetActivity } from '@/composables/useActivity';
import vector from '../fixtures/admin-signature-vector.json';

const fetchMock = vi.fn();
let session: AdminSession;

const reply = (status: number, json: object) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const skew = (serverTime: number) => reply(401, { error: 'Your clock is off', code: 'clock_skew', serverTime });

beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  const made = await generateAdminSecret();
  session = { stormCode: 'abcd-efgh', secret: made.secret };
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetClockOffset();
  resetActivity();
});

const sent = (call = 0) => {
  const init = fetchMock.mock.calls[call][1] as RequestInit & { headers: Record<string, string> };
  const match = /^storm=(\w+), ts=(\d+), sig=([A-Za-z0-9_-]+)$/.exec(init.headers['x-admin-signature'])!;
  return { init, storm: match[1], ts: Number(match[2]), sig: match[3] };
};

async function verifies(call: number, method: string, fn: string, body?: string) {
  const { storm, ts, sig } = sent(call);
  const text = await canonicalText({ method, functionName: fn, stormCode: storm, ts, body });
  const pub = fromBase64Url((await describeSecret(session.secret)).publicKey);
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') },
    format: 'jwk',
  });
  return verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
}

describe('canonicalText', () => {
  it('matches the shared vector', async () => {
    expect(await canonicalText(vector.input)).toBe(vector.canonicalText);
  });
});

describe('signedApi', () => {
  it('sends a signature header and never the secret', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await signedApi(session, 'admin-storm');
    const { init } = sent();
    expect(init.headers['x-admin-signature']).toMatch(/^storm=ABCDEFGH, ts=\d+, sig=[A-Za-z0-9_-]{86}$/);
    expect(init.headers).not.toHaveProperty('x-admin-key');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(session.secret);
  });

  it('sends a signature that verifies', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await signedApi(session, 'admin-storm');
    expect(await verifies(0, 'GET', 'admin-storm')).toBe(true);
  });

  it('signs the body of a PATCH', async () => {
    const body = JSON.stringify({ status: 'closed' });
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await signedApi(session, 'admin-storm', { method: 'PATCH', body });
    expect(await verifies(0, 'PATCH', 'admin-storm', body)).toBe(true);
    expect(await verifies(0, 'PATCH', 'admin-storm', JSON.stringify({ status: 'active' }))).toBe(false);
  });

  it('retries once with the server clock after a clock_skew answer', async () => {
    const serverTime = Date.now() + 10 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(skew(serverTime)).mockResolvedValueOnce(reply(200, { done: true }));
    await expect(signedApi(session, 'admin-storm')).resolves.toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Math.abs(sent(1).ts - serverTime)).toBeLessThan(1000);
    expect(await verifies(1, 'GET', 'admin-storm')).toBe(true);
  });

  it('gives up if the second attempt is skewed too', async () => {
    fetchMock.mockResolvedValue(skew(Date.now() + 600000));
    await expect(signedApi(session, 'admin-storm')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry any other 401', async () => {
    fetchMock.mockResolvedValue(reply(401, { error: 'Not allowed' }));
    await expect(signedApi(session, 'admin-storm')).rejects.toThrow('Not allowed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves no failure notice behind when a skewed first attempt then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(skew(Date.now() + 600000)).mockResolvedValueOnce(reply(200, { ok: true }));
    await signedApi(session, 'admin-storm', { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
    expect(activity.value?.kind).not.toBe('error');
  });

  it('shows a failure notice when the request finally fails', async () => {
    fetchMock.mockResolvedValue(reply(403, { error: 'Nope' }));
    await expect(signedApi(session, 'admin-storm', { method: 'PATCH', body: '{}' })).rejects.toThrow('Nope');
    expect(activity.value).toEqual({ kind: 'error', message: 'Nope' });
  });

  it('says a secure connection is needed, instead of a TypeError, when crypto.subtle is missing', async () => {
    vi.stubGlobal('crypto', {});
    try {
      await expect(signedApi(session, 'admin-storm')).rejects.toThrow(/secure connection/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('crypto', webcrypto);
    }
  });

  it('resetClockOffset puts the offset back to zero', async () => {
    const far = Date.now() + 3600000;
    fetchMock.mockResolvedValueOnce(skew(far)).mockResolvedValueOnce(reply(200, {}));
    await signedApi(session, 'admin-storm');
    resetClockOffset();
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await signedApi(session, 'admin-storm');
    expect(Math.abs(sent(2).ts - Date.now())).toBeLessThan(1000);
  });
});
