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

// A pairing channel is a private meeting point between two of the same person's devices. The token allows publishing and
// subscribing on exactly that channel, so it cannot be used to reach storms or any other pairing.
export async function createPairTokenRequest(id) {
  return getClient().auth.createTokenRequest({
    capability: { [`pair:${id}`]: ['publish', 'subscribe'] },
    ttl: 5 * 60 * 1000,
  });
}
