import Ably from 'ably';

let restClient;

function getClient() {
  if (!restClient) {
    restClient = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  }
  return restClient;
}

export async function publishEvent(roomCode, eventName, payload) {
  const channel = getClient().channels.get(`room:${roomCode}`);
  await channel.publish(eventName, payload);
}

export async function createTokenRequest(roomCode, clientId) {
  return getClient().auth.createTokenRequest({
    capability: { [`room:${roomCode}`]: ['subscribe', 'presence'] },
    ...(clientId ? { clientId } : {}),
  });
}
