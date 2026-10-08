export interface AdminSecret {
  secret: string;
  publicKey: string;
  resultsKey: string;
  resultsKeyHash: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SECRET_BYTES = 96;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const toHex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

export function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Presenting needs a secure connection (HTTPS). Open VoteStorm over https:// and try again.');
  return crypto.subtle;
}

function split(secret: string) {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(secret);
  } catch {
    throw new Error('The presenter link is not valid');
  }
  if (bytes.length !== SECRET_BYTES) throw new Error('The presenter link is not valid');
  return { d: bytes.slice(0, 32), x: bytes.slice(32, 64), y: bytes.slice(64) };
}

/** The values derived from a secret: its public key, and the results key a viewer can use. The secret never leaves the browser. */
export async function describeSecret(secret: string): Promise<AdminSecret> {
  const { d, x, y } = split(secret);
  const publicKey = new Uint8Array(65);
  publicKey[0] = 4;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  const hmacKey = await subtle().importKey('raw', d, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await subtle().sign('HMAC', hmacKey, encoder.encode('votestorm-results'));
  const resultsKey = toHex(mac).slice(0, 24);
  const resultsKeyHash = toHex(await subtle().digest('SHA-256', encoder.encode('results:' + resultsKey)));
  return { secret, publicKey: toBase64Url(publicKey), resultsKey, resultsKeyHash };
}

export async function generateAdminSecret(): Promise<AdminSecret> {
  const pair = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  const bytes = new Uint8Array(SECRET_BYTES);
  bytes.set(fromBase64Url(jwk.d!), 0);
  bytes.set(fromBase64Url(jwk.x!), 32);
  bytes.set(fromBase64Url(jwk.y!), 64);
  return describeSecret(toBase64Url(bytes));
}

/** The signing key for a secret, imported as non-extractable so scripts on the page cannot read it back out. */
export async function importSigner(secret: string): Promise<CryptoKey> {
  const { d, x, y } = split(secret);
  const jwk = { kty: 'EC', crv: 'P-256', d: toBase64Url(d), x: toBase64Url(x), y: toBase64Url(y) };
  return subtle().importKey('jwk', jwk, ECDSA, false, ['sign']);
}
