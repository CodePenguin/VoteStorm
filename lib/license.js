import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

// A license is a signed JWT carrying the limits that apply to the presenter who holds it. VoteStorm does not
// mint or sell licenses: any OIDC-style issuer (or a self-hosted key) can sign them. Trusted issuers and keys
// come from the environment:
//   ALLOWED_LICENSE_ISSUERS  comma-separated issuer URLs, matched exactly against the token's `iss`
//   LICENSE_JWKS_JSON        optional inline JWKS ({"keys":[...]}); otherwise keys come from OIDC discovery
//   LICENSE_CLAIM_NAMESPACE  optional prefix for claim names (Auth0 requires namespaced custom claims)
//   LICENSE_AUDIENCE         optional required `aud`
//   ANONYMOUS_LICENSE_JSON   optional limits for the anonymous tier, e.g. {"roomInactivityHours":24,"maxAudiencePerRoom":50}

export const DEFAULT_INACTIVITY_HOURS = 24;
export const LIMIT_KEYS = ['roomInactivityHours', 'maxQuestionsPerRoom', 'maxAudiencePerRoom', 'maxActiveRooms'];

export class LicenseError extends Error {}

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Keeps only valid positive-integer limits. A missing limit means unlimited (except inactivity, which always has a value). */
export function normalizeLimits(source = {}, fallbackInactivityHours = DEFAULT_INACTIVITY_HOURS) {
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const n = positiveInt(source[key]);
    if (n !== undefined) limits[key] = n;
  }
  if (limits.roomInactivityHours === undefined) limits.roomInactivityHours = fallbackInactivityHours;
  return limits;
}

export function anonymousLicense(env = process.env) {
  let overrides = {};
  if (env.ANONYMOUS_LICENSE_JSON) {
    try {
      overrides = JSON.parse(env.ANONYMOUS_LICENSE_JSON);
    } catch {
      console.warn('ANONYMOUS_LICENSE_JSON is not valid JSON; using the built-in anonymous limits.');
    }
  }
  return { id: 'anonymous', name: null, tier: 'anonymous', expiresAt: null, ...normalizeLimits(overrides) };
}

const discoveryCache = new Map();
const remoteKeySets = new Map();

async function jwksUriFor(issuer) {
  let promise = discoveryCache.get(issuer);
  if (!promise) {
    promise = fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
      .then((res) => {
        if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
        return res.json();
      })
      .then((doc) => {
        if (!doc.jwks_uri) throw new Error('discovery document has no jwks_uri');
        return doc.jwks_uri;
      });
    discoveryCache.set(issuer, promise);
    promise.catch(() => discoveryCache.delete(issuer));
  }
  return promise;
}

async function keysFor(issuer, env) {
  if (env.LICENSE_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.LICENSE_JWKS_JSON));
  let keySet = remoteKeySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(await jwksUriFor(issuer)));
    remoteKeySets.set(issuer, keySet);
  }
  return keySet;
}

export async function validateLicenseJwt(jwt, env = process.env) {
  const allowed = (env.ALLOWED_LICENSE_ISSUERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) throw new LicenseError('Licensing is not configured on this server');

  let issuer;
  try {
    issuer = decodeJwt(jwt).iss;
  } catch {
    throw new LicenseError('Invalid license');
  }
  if (!issuer || !allowed.includes(issuer)) throw new LicenseError('Invalid license: untrusted issuer');

  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, await keysFor(issuer, env), {
      issuer,
      algorithms: ['ES256', 'RS256'],
      clockTolerance: 5,
      ...(env.LICENSE_AUDIENCE ? { audience: env.LICENSE_AUDIENCE } : {}),
    }));
  } catch (err) {
    throw new LicenseError(err?.code === 'ERR_JWT_EXPIRED' ? 'This license has expired' : 'Invalid license');
  }
  if (!payload.sub) throw new LicenseError('Invalid license: missing subject');

  const ns = env.LICENSE_CLAIM_NAMESPACE ?? '';
  const claim = (key) => payload[ns + key] ?? payload[key];
  const source = {};
  for (const key of LIMIT_KEYS) source[key] = claim(key);
  const name = claim('name');

  return {
    id: payload.sub,
    name: typeof name === 'string' ? name : null,
    tier: 'licensed',
    expiresAt: payload.exp ? payload.exp * 1000 : null,
    ...normalizeLimits(source, anonymousLicense(env).roomInactivityHours),
  };
}

export function bearerToken(event) {
  const header = event?.headers?.authorization ?? event?.headers?.Authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1].trim() : null;
}

/** The license a request runs under: its presented JWT (throws LicenseError if invalid) or the anonymous tier. */
export async function resolveLicense(event, env = process.env) {
  const token = bearerToken(event);
  return token ? validateLicenseJwt(token, env) : anonymousLicense(env);
}

/** What is stored on a room so its limits keep applying to the audience, who present no license. */
export function licenseSnapshot(license) {
  return JSON.stringify(license);
}

export function roomLicense(room, env = process.env) {
  if (room?.license_json) {
    try {
      return { ...anonymousLicense(env), ...JSON.parse(room.license_json) };
    } catch {
      /* fall through */
    }
  }
  return anonymousLicense(env);
}

/** Presenter requests that carry a valid license (re)attach it to the room; an invalid one is ignored. */
export async function applyPresentedLicense(db, room, event, env = process.env) {
  const token = bearerToken(event);
  if (!token) return roomLicense(room, env);
  let license;
  try {
    license = await validateLicenseJwt(token, env);
  } catch {
    return roomLicense(room, env);
  }
  const snapshot = licenseSnapshot(license);
  if (room.license_json !== snapshot) {
    await db.execute({
      sql: 'UPDATE rooms SET license_json = ?, license_id = ?, inactivity_hours = ? WHERE room_code = ?',
      args: [snapshot, license.id, license.roomInactivityHours, room.room_code],
    });
  }
  return license;
}

export function describeLicense(license) {
  const { id, name, tier, expiresAt, ...limits } = license;
  return { tier, name, expiresAt, limits };
}
