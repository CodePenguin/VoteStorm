import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/realtime.js', () => ({
  publishEvent: vi.fn(),
  createTokenRequest: vi.fn(async (roomCode) => ({ keyName: 'fake', capability: `{"room:${roomCode}":["subscribe"]}` })),
}));

import { handler } from '../../netlify/functions/ably-token.js';

describe('ably-token function', () => {
  it('returns a token request scoped to the room channel', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: { roomCode: 'ROOM01' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.capability).toContain('room:ROOM01');
  });

  it('passes a valid clientId through and ignores a malformed one', async () => {
    const { createTokenRequest } = await import('../../lib/realtime.js');
    createTokenRequest.mockClear();
    await handler({ httpMethod: 'GET', queryStringParameters: { roomCode: 'ROOM01', clientId: 'abc-123' } });
    expect(createTokenRequest).toHaveBeenLastCalledWith('ROOM01', 'abc-123');
    await handler({ httpMethod: 'GET', queryStringParameters: { roomCode: 'ROOM01', clientId: 'bad id!*' } });
    expect(createTokenRequest).toHaveBeenLastCalledWith('ROOM01', undefined);
  });

  it('requires roomCode', async () => {
    const res = await handler({ httpMethod: 'GET', queryStringParameters: {} });
    expect(res.statusCode).toBe(400);
  });
});
