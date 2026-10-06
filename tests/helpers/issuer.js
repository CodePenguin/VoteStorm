import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/** A throwaway license issuer: an ES256 key pair, its JWKS, and a signer, so tests use real signed tokens. */
export async function makeIssuer(issuer = 'https://licenses.example.test') {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const sign = async (claims = {}, { sub = 'license-1', expiresIn = '1h', iss = issuer, key = privateKey, alg = 'ES256', aud } = {}) => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: 'test-key' }).setSubject(sub).setIssuer(iss).setIssuedAt();
    if (expiresIn) jwt.setExpirationTime(expiresIn);
    if (aud) jwt.setAudience(aud);
    return jwt.sign(key);
  };
  // Every server needs a license for the anonymous tier; this is the usual one (24 hours, nothing else limited).
  const anonymousJwt = await sign({ name: 'Anonymous' }, { sub: 'anonymous', expiresIn: '3650d' });
  return { issuer, jwks: { keys: [jwk] }, privateKey, sign, anonymousJwt };
}

/** Points the license environment at an issuer (inline JWKS, no network). Returns a function that restores it. */
export function useIssuer(issuer, extra = {}) {
  const keys = ['ALLOWED_LICENSE_ISSUERS', 'LICENSE_JWKS_JSON', 'LICENSE_CLAIM_NAMESPACE', 'LICENSE_AUDIENCE', 'ANONYMOUS_LICENSE_JWT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.ALLOWED_LICENSE_ISSUERS = issuer.issuer;
  process.env.LICENSE_JWKS_JSON = JSON.stringify(issuer.jwks);
  process.env.ANONYMOUS_LICENSE_JWT = issuer.anonymousJwt;
  Object.assign(process.env, extra);
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

export const bearer = (jwt) => ({ authorization: `Bearer ${jwt}` });
