import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  ConfigError, LicenseError, anonymousLicense, bearerToken, describeLicense, legacyStormLicense, normalizeLimits, resolveLicense, stormLicense, validateLicenseJwt,
} from '../../lib/license.js';
import { bearer, makeIssuer, useIssuer } from '../helpers/issuer.js';

describe('license validation', () => {
  let issuer;
  let restore;

  beforeAll(async () => {
    issuer = await makeIssuer();
  });
  beforeEach(() => {
    restore = useIssuer(issuer);
  });
  afterEach(() => restore());

  it('accepts a signed license and reads its name and limits', async () => {
    const jwt = await issuer.sign({ name: 'Acme Training', stormInactivityHours: 72, maxQuestionsPerStorm: 40, maxAudiencePerStorm: 500, maxActiveStorms: 3 }, { sub: 'acme' });
    const license = await validateLicenseJwt(jwt);
    expect(license).toMatchObject({
      id: 'acme', name: 'Acme Training', tier: 'licensed',
      stormInactivityHours: 72, maxQuestionsPerStorm: 40, maxAudiencePerStorm: 500, maxActiveStorms: 3,
    });
    expect(license.expiresAt).toBeGreaterThan(Date.now());
  });

  it('treats absent limits as unlimited, but a storm always has an inactivity window', async () => {
    const license = await validateLicenseJwt(await issuer.sign({ name: 'Minimal' }));
    expect(license.maxQuestionsPerStorm).toBeUndefined();
    expect(license.maxAudiencePerStorm).toBeUndefined();
    expect(license.maxActiveStorms).toBeUndefined();
    expect(license.stormInactivityHours).toBe(24);
  });

  it('ignores limits that are not positive whole numbers instead of trusting them', () => {
    const limits = normalizeLimits({ stormInactivityHours: 0, maxQuestionsPerStorm: -5, maxAudiencePerStorm: 1.5, maxActiveStorms: 'lots' });
    expect(limits).toEqual({ stormInactivityHours: 24 });
    expect(normalizeLimits({ maxQuestionsPerStorm: '12' })).toMatchObject({ maxQuestionsPerStorm: 12 });
  });

  it('reads namespaced claims when a namespace is configured (as Auth0 requires), falling back to plain ones', async () => {
    restore();
    restore = useIssuer(issuer, { LICENSE_CLAIM_NAMESPACE: 'https://votestorm.example/' });
    const jwt = await issuer.sign({
      'https://votestorm.example/name': 'Namespaced', 'https://votestorm.example/maxQuestionsPerStorm': 9, maxAudiencePerStorm: 20,
    });
    expect(await validateLicenseJwt(jwt)).toMatchObject({ name: 'Namespaced', maxQuestionsPerStorm: 9, maxAudiencePerStorm: 20 });
  });

  it('rejects an expired license with a clear message', async () => {
    const jwt = await issuer.sign({}, { expiresIn: '-1h' });
    await expect(validateLicenseJwt(jwt)).rejects.toThrow('This license has expired');
  });

  it('rejects a token from an issuer that is not trusted', async () => {
    const other = await makeIssuer('https://other.example.test');
    await expect(validateLicenseJwt(await other.sign({}))).rejects.toThrow('untrusted issuer');
  });

  it('rejects a token signed with a different key, even if it claims a trusted issuer', async () => {
    const attacker = await generateKeyPair('ES256');
    const forged = await issuer.sign({ maxAudiencePerStorm: 1000000 }, { key: attacker.privateKey });
    await expect(validateLicenseJwt(forged)).rejects.toThrow(LicenseError);
  });

  it('rejects symmetric and unsigned tokens, and garbage', async () => {
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('x').setIssuer(issuer.issuer).setExpirationTime('1h').sign(new TextEncoder().encode('secret-secret-secret-secret-secret!'));
    await expect(validateLicenseJwt(hs)).rejects.toThrow(LicenseError);
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: issuer.issuer, sub: 'x' })).toString('base64url')}.`;
    await expect(validateLicenseJwt(unsigned)).rejects.toThrow(LicenseError);
    await expect(validateLicenseJwt('not-a-jwt')).rejects.toThrow('Invalid license');
  });

  it('rejects a license with no subject (it could not be counted per license)', async () => {
    const key = issuer.privateKey;
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(issuer.issuer).setExpirationTime('1h').sign(key);
    await expect(validateLicenseJwt(jwt)).rejects.toThrow('missing subject');
  });

  it('enforces the audience when one is configured', async () => {
    restore();
    restore = useIssuer(issuer, { LICENSE_AUDIENCE: 'votestorm' });
    await expect(validateLicenseJwt(await issuer.sign({}, { aud: 'something-else' }))).rejects.toThrow(LicenseError);
    await expect(validateLicenseJwt(await issuer.sign({}, { aud: 'votestorm' }))).resolves.toMatchObject({ tier: 'licensed' });
  });

  it('refuses every license when the server has no trusted issuers configured', async () => {
    delete process.env.ALLOWED_LICENSE_ISSUERS;
    await expect(validateLicenseJwt(await issuer.sign({}))).rejects.toThrow('not configured');
  });

  it('resolves a request to the anonymous tier, or to its bearer license', async () => {
    expect((await resolveLicense({ headers: {} })).tier).toBe('anonymous');
    expect((await resolveLicense({})).tier).toBe('anonymous');
    const jwt = await issuer.sign({ maxQuestionsPerStorm: 5 });
    expect(await resolveLicense({ headers: bearer(jwt) })).toMatchObject({ tier: 'licensed', maxQuestionsPerStorm: 5 });
    expect(await resolveLicense({ headers: { Authorization: `bearer ${jwt}` } })).toMatchObject({ tier: 'licensed' });
    await expect(resolveLicense({ headers: bearer('junk') })).rejects.toThrow(LicenseError);
  });

  it('extracts bearer tokens only from well-formed headers', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(bearerToken({ headers: {} })).toBeNull();
  });

  it('describes a license without exposing its id', async () => {
    const described = describeLicense(await validateLicenseJwt(await issuer.sign({ name: 'N', maxAudiencePerStorm: 7 }, { sub: 'secret-id' })));
    expect(described).toMatchObject({ tier: 'licensed', name: 'N', limits: { maxAudiencePerStorm: 7, stormInactivityHours: 24 } });
    expect(JSON.stringify(described)).not.toContain('secret-id');
  });
});

describe('anonymous tier', () => {
  let issuer;
  beforeAll(async () => {
    issuer = await makeIssuer('https://anon.example.test');
  });

  const envWith = (token, extra = {}) => ({
    ALLOWED_LICENSE_ISSUERS: issuer.issuer, LICENSE_JWKS_JSON: JSON.stringify(issuer.jwks), ANONYMOUS_LICENSE_JWT: token, ...extra,
  });

  it('is always required: with none set there is no default, even on a developer machine', async () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'production' }, { AWS_LAMBDA_FUNCTION_NAME: 'fn', NETLIFY_DEV: 'true' }, { ANONYMOUS_LICENSE_JWT: '   ' }]) {
      await expect(anonymousLicense(env)).rejects.toThrow('ANONYMOUS_LICENSE_JWT is not set');
      await expect(anonymousLicense(env)).rejects.toThrow(ConfigError);
    }
  });

  it('takes its limits from a signed license, so it follows the same rules and code path as any other', async () => {
    const jwt = await issuer.sign({ name: 'Public', stormInactivityHours: 12, maxQuestionsPerStorm: 5, maxAudiencePerStorm: 30 }, { sub: 'whatever-subject' });
    const license = await anonymousLicense(envWith(jwt));
    expect(license).toMatchObject({ id: 'anonymous', tier: 'anonymous', name: 'Public', stormInactivityHours: 12, maxQuestionsPerStorm: 5, maxAudiencePerStorm: 30 });
    expect(license.expiresAt).toBeGreaterThan(Date.now());
  });

  it('is what a request with no license of its own runs under', async () => {
    const jwt = await issuer.sign({ maxAudiencePerStorm: 7 });
    const license = await resolveLicense({ headers: {} }, envWith(jwt));
    expect(license).toMatchObject({ tier: 'anonymous', maxAudiencePerStorm: 7 });
  });

  it('reads namespaced claims like any other license', async () => {
    const jwt = await issuer.sign({ 'https://votestorm.example/maxQuestionsPerStorm': 9 });
    expect(await anonymousLicense(envWith(jwt, { LICENSE_CLAIM_NAMESPACE: 'https://votestorm.example/' }))).toMatchObject({ maxQuestionsPerStorm: 9 });
  });

  it('is a configuration error, not a fallback, when the license is expired, forged, from an untrusted issuer or garbage', async () => {
    const attacker = await generateKeyPair('ES256');
    const other = await makeIssuer('https://elsewhere.example.test');
    for (const jwt of [await issuer.sign({ maxQuestionsPerStorm: 1 }, { expiresIn: '-1h' }), await issuer.sign({ maxQuestionsPerStorm: 1 }, { key: attacker.privateKey }), await other.sign({ maxQuestionsPerStorm: 1 }), 'garbage-token']) {
      await expect(anonymousLicense(envWith(jwt))).rejects.toThrow(ConfigError);
    }
    await expect(anonymousLicense(envWith(await issuer.sign({}, { expiresIn: '-1h' })))).rejects.toThrow('ANONYMOUS_LICENSE_JWT is not usable: This license has expired');
  });

  it('is a configuration error when the issuers it needs are not configured at all', async () => {
    const jwt = await issuer.sign({});
    await expect(anonymousLicense({ ANONYMOUS_LICENSE_JWT: jwt })).rejects.toThrow('not usable: Licensing is not configured');
  });

  it('a bad anonymous license is an error wherever the server runs, so a mistake is never hidden', async () => {
    await expect(anonymousLicense(envWith('junk', { NODE_ENV: 'development' }))).rejects.toThrow(ConfigError);
    await expect(anonymousLicense(envWith('junk', { NODE_ENV: 'production' }))).rejects.toThrow(ConfigError);
  });

  it('does not check the signature again on every request', async () => {
    const jwt = await issuer.sign({ stormInactivityHours: 6 });
    const first = await anonymousLicense(envWith(jwt));
    const second = await anonymousLicense(envWith(jwt, { LICENSE_JWKS_JSON: '{"keys":[]}' })); // would fail if it re-validated
    expect(second).toBe(first);
  });

  it('gives a storm with no stored license (created before licensing existed) the old 24-hour default, and a stored license the storm remembers', () => {
    expect(stormLicense({})).toEqual(legacyStormLicense());
    expect(stormLicense({ license_json: 'not json' })).toEqual(legacyStormLicense());
    expect(legacyStormLicense().stormInactivityHours).toBe(24);
    expect(stormLicense({ license_json: JSON.stringify({ id: 'x', tier: 'licensed', maxAudiencePerStorm: 3, stormInactivityHours: 48 }) })).toMatchObject({ tier: 'licensed', maxAudiencePerStorm: 3, stormInactivityHours: 48 });
  });
});

describe('issuer discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds the signing keys through OIDC discovery when no inline JWKS is configured', async () => {
    const issuer = await makeIssuer('https://discover.example.test/');
    const calls = [];
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      calls.push(u);
      if (u === 'https://discover.example.test/.well-known/openid-configuration') {
        return new Response(JSON.stringify({ jwks_uri: 'https://discover.example.test/keys.json' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://discover.example.test/keys.json') {
        return new Response(JSON.stringify(issuer.jwks), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('nope', { status: 404 });
    });
    const license = await validateLicenseJwt(await issuer.sign({ name: 'Discovered' }, { sub: 'd1' }), { ALLOWED_LICENSE_ISSUERS: 'https://discover.example.test/' });
    expect(license).toMatchObject({ id: 'd1', name: 'Discovered' });
    expect(calls).toEqual(['https://discover.example.test/.well-known/openid-configuration', 'https://discover.example.test/keys.json']);
  });

  it('rejects licenses when discovery fails', async () => {
    const issuer = await makeIssuer('https://down.example.test');
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await expect(validateLicenseJwt(await issuer.sign({}), { ALLOWED_LICENSE_ISSUERS: 'https://down.example.test' })).rejects.toThrow('Invalid license');
  });
});

describe('jwk export helper', () => {
  it('produces a JWKS the validator accepts for RS256 issuers too', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'rsa', alg: 'RS256', use: 'sig' };
    const jwt = await new SignJWT({ maxActiveStorms: 2 }).setProtectedHeader({ alg: 'RS256', kid: 'rsa' }).setSubject('rsa-licensee').setIssuer('https://rsa.example.test').setExpirationTime('1h').sign(privateKey);
    const license = await validateLicenseJwt(jwt, { ALLOWED_LICENSE_ISSUERS: 'https://rsa.example.test', LICENSE_JWKS_JSON: JSON.stringify({ keys: [jwk] }) });
    expect(license).toMatchObject({ id: 'rsa-licensee', maxActiveStorms: 2 });
  });
});
