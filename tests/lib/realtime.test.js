import { describe, it, expect, vi, beforeEach } from 'vitest';

const createTokenRequest = vi.fn(async (params) => ({ keyName: 'fake', ...params }));
vi.mock('ably', () => ({
  default: { Rest: class { auth = { createTokenRequest }; channels = { get: () => ({ publish: vi.fn() }) }; } },
}));

import { createPairTokenRequest } from '../../lib/realtime.js';

describe('createPairTokenRequest', () => {
  beforeEach(() => createTokenRequest.mockClear());

  it('limits the token to publishing and subscribing on exactly one pair channel, for five minutes', async () => {
    const id = 'a'.repeat(64);
    await createPairTokenRequest(id);
    expect(createTokenRequest).toHaveBeenCalledTimes(1);
    const params = createTokenRequest.mock.calls[0][0];
    expect(params.capability).toEqual({ [`pair:${id}`]: ['publish', 'subscribe'] });
    expect(params.ttl).toBe(5 * 60 * 1000);
    expect(params.clientId).toBeUndefined();
  });
});
