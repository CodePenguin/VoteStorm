// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '@/api';
import { clearStoredLicense, setStoredLicense } from '@/licenseStorage';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  clearStoredLicense();
});
afterEach(() => vi.unstubAllGlobals());

const sentHeaders = () => fetchMock.mock.calls[0][1].headers as Record<string, string>;

describe('api()', () => {
  it('sends the stored license on presenter requests only', async () => {
    setStoredLicense('my.jwt.token');
    for (const path of ['create-room', 'admin-room?adminKey=abc', 'admin-questions', 'license-status']) {
      fetchMock.mockClear();
      await api(path);
      expect(sentHeaders().authorization).toBe('Bearer my.jwt.token');
    }
    for (const path of ['vote', 'get-room-state?roomCode=ABC', 'get-room-results', 'ably-token?roomCode=X', 'results-activate', 'resolve-results-key?key=k']) {
      fetchMock.mockClear();
      await api(path);
      expect(sentHeaders().authorization).toBeUndefined();
    }
  });

  it('sends no Authorization header when there is no license, and lets a caller supply its own', async () => {
    await api('create-room');
    expect(sentHeaders().authorization).toBeUndefined();
    setStoredLicense('stored.jwt');
    fetchMock.mockClear();
    await api('license-status', { headers: { authorization: 'Bearer candidate.jwt' } });
    expect(sentHeaders().authorization).toBe('Bearer candidate.jwt');
  });

  it('raises ApiError carrying the status and the server error code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'This license has expired', code: 'license_invalid' }), { status: 401 }));
    const err = (await api('create-room').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'This license has expired', status: 401, code: 'license_invalid' });
  });
});
