import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  LicenseError, anonymousLicense, bearerToken, describeLicense, normalizeLimits, resolveLicense, validateLicenseJwt,
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
    const jwt = await issuer.sign({ name: 'Acme Training', roomInactivityHours: 72, maxQuestionsPerRoom: 40, maxAudiencePerRoom: 500, maxActiveRooms: 3 }, { sub: 'acme' });
    const license = await validateLicenseJwt(jwt);
    expect(license).toMatchObject({
      id: 'acme', name: 'Acme Training', tier: 'licensed',
      roomInactivityHours: 72, maxQuestionsPerRoom: 40, maxAudiencePerRoom: 500, maxActiveRooms: 3,
    });
    expect(license.expiresAt).toBeGreaterThan(Date.now());
  });

  it('treats absent limits as unlimited, but a room always has an inactivity window', async () => {
    const license = await validateLicenseJwt(await issuer.sign({ name: 'Minimal' }));
    expect(license.maxQuestionsPerRoom).toBeUndefined();
    expect(license.maxAudiencePerRoom).toBeUndefined();
    expect(license.maxActiveRooms).toBeUndefined();
    expect(license.roomInactivityHours).toBe(24);
  });

  it('ignores limits that are not positive whole numbers instead of trusting them', () => {
    const limits = normalizeLimits({ roomInactivityHours: 0, maxQuestionsPerRoom: -5, maxAudiencePerRoom: 1.5, maxActiveRooms: 'lots' });
    expect(limits).toEqual({ roomInactivityHours: 24 });
    expect(normalizeLimits({ maxQuestionsPerRoom: '12' })).toMatchObject({ maxQuestionsPerRoom: 12 });
  });

  it('reads namespaced claims when a namespace is configured (as Auth0 requires), falling back to plain ones', async () => {
    restore();
    restore = useIssuer(issuer, { LICENSE_CLAIM_NAMESPACE: 'https://votestorm.example/' });
    const jwt = await issuer.sign({
      'https://votestorm.example/name': 'Namespaced', 'https://votestorm.example/maxQuestionsPerRoom': 9, maxAudiencePerRoom: 20,
    });
    expect(await validateLicenseJwt(jwt)).toMatchObject({ name: 'Namespaced', maxQuestionsPerRoom: 9, maxAudiencePerRoom: 20 });
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
    const forged = await issuer.sign({ maxAudiencePerRoom: 1000000 }, { key: attacker.privateKey });
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
    const jwt = await issuer.sign({ maxQuestionsPerRoom: 5 });
    expect(await resolveLicense({ headers: bearer(jwt) })).toMatchObject({ tier: 'licensed', maxQuestionsPerRoom: 5 });
    expect(await resolveLicense({ headers: { Authorization: `bearer ${jwt}` } })).toMatchObject({ tier: 'licensed' });
    await expect(resolveLicense({ headers: bearer('junk') })).rejects.toThrow(LicenseError);
  });

  it('extracts bearer tokens only from well-formed headers', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(bearerToken({ headers: {} })).toBeNull();
  });

  it('describes a license without exposing its id', async () => {
    const described = describeLicense(await validateLicenseJwt(await issuer.sign({ name: 'N', maxAudiencePerRoom: 7 }, { sub: 'secret-id' })));
    expect(described).toMatchObject({ tier: 'licensed', name: 'N', limits: { maxAudiencePerRoom: 7, roomInactivityHours: 24 } });
    expect(JSON.stringify(described)).not.toContain('secret-id');
  });
});

describe('anonymous tier', () => {
  it('defaults to a 24-hour inactivity window with no other limits', () => {
    expect(anonymousLicense({})).toEqual({ id: 'anonymous', name: null, tier: 'anonymous', expiresAt: null, roomInactivityHours: 24 });
  });

  it('takes its limits from configuration, so they are not hardcoded', () => {
    const license = anonymousLicense({ ANONYMOUS_LICENSE_JSON: JSON.stringify({ roomInactivityHours: 12, maxQuestionsPerRoom: 5, maxAudiencePerRoom: 30 }) });
    expect(license).toMatchObject({ roomInactivityHours: 12, maxQuestionsPerRoom: 5, maxAudiencePerRoom: 30 });
  });

  it('falls back to the built-in limits (with a warning) when the configuration is not valid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(anonymousLicense({ ANONYMOUS_LICENSE_JSON: '{nope' }).roomInactivityHours).toBe(24);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
    const jwt = await new SignJWT({ maxActiveRooms: 2 }).setProtectedHeader({ alg: 'RS256', kid: 'rsa' }).setSubject('rsa-licensee').setIssuer('https://rsa.example.test').setExpirationTime('1h').sign(privateKey);
    const license = await validateLicenseJwt(jwt, { ALLOWED_LICENSE_ISSUERS: 'https://rsa.example.test', LICENSE_JWKS_JSON: JSON.stringify({ keys: [jwk] }) });
    expect(license).toMatchObject({ id: 'rsa-licensee', maxActiveRooms: 2 });
  });
});
