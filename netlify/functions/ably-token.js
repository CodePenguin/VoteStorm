import { createTokenRequest } from '../../lib/realtime.js';
import { json } from '../../lib/http.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const roomCode = event.queryStringParameters?.roomCode;
  if (!roomCode) return json(400, { error: 'roomCode is required' });

  const tokenRequest = await createTokenRequest(roomCode);
  return json(200, tokenRequest);
}
