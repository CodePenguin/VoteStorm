// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.fn();
vi.mock('@/api', () => ({ api: (...a: unknown[]) => apiMock(...a) }));
const generateMock = vi.fn(async () => ({ secret: 'NEW-SECRET', publicKey: 'NEW-PUB', resultsKey: 'RK', resultsKeyHash: 'NEW-HASH' }));
vi.mock('@/lib/adminKeys', () => ({ generateAdminSecret: () => generateMock() }));

import { deleteLicensedStorm, listLicensedStorms, reclaimStorm } from '@/lib/licenseStorms';

describe('licenseStorms', () => {
  beforeEach(() => {
    apiMock.mockReset();
    generateMock.mockClear();
  });

  it('lists the Storms from the server', async () => {
    apiMock.mockResolvedValue({ storms: [{ stormCode: 'ABCD1234' }] });
    expect(await listLicensedStorms()).toEqual([{ stormCode: 'ABCD1234' }]);
    expect(apiMock).toHaveBeenCalledWith('license-storms');
  });

  it('reclaims with a key made in this browser, sends only its public half, and returns the new secret', async () => {
    apiMock.mockResolvedValue({ ok: true });
    expect(await reclaimStorm('ABCD1234')).toEqual({ stormCode: 'ABCD1234', secret: 'NEW-SECRET' });
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe('license-storms');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ stormCode: 'ABCD1234', publicKey: 'NEW-PUB', resultsKeyHash: 'NEW-HASH' });
    expect(init.body).not.toContain('NEW-SECRET');
  });

  it('does not hand back a secret when the server refuses the reclaim', async () => {
    apiMock.mockRejectedValue(new Error('nope'));
    await expect(reclaimStorm('ABCD1234')).rejects.toThrow('nope');
  });

  it('deletes by code', async () => {
    apiMock.mockResolvedValue({ ok: true });
    await deleteLicensedStorm('ABCD1234');
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe('license-storms');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ stormCode: 'ABCD1234' });
  });
});
