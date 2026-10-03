import { createTokenRequest } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const roomCode = event.queryStringParameters?.roomCode;
  if (!roomCode) return json(400, { error: 'roomCode is required' });

  // Optional: lets a voter's browser join the room's presence set (live "connected" count).
  const rawClientId = event.queryStringParameters?.clientId;
  const clientId = rawClientId && /^[\w-]{1,100}$/.test(rawClientId) ? rawClientId : undefined;

  const tokenRequest = await createTokenRequest(roomCode, clientId);
  return json(200, tokenRequest);
}
