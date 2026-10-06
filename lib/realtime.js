import Ably from 'ably';

let restClient;

function getClient() {
  if (!restClient) {
    restClient = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  }
  return restClient;
}

export async function publishEvent(stormCode, eventName, payload) {
  const channel = getClient().channels.get(`storm:${stormCode}`);
  await channel.publish(eventName, payload);
}

export async function createTokenRequest(stormCode, clientId) {
  return getClient().auth.createTokenRequest({
    capability: { [`storm:${stormCode}`]: ['subscribe', 'presence'] },
    ...(clientId ? { clientId } : {}),
  });
}
