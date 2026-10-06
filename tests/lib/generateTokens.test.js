import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, mintLicense, setupKeys } from '../../scripts/generate-tokens.mjs';
import { validateLicenseJwt } from '../../lib/license.js';

describe('generate-tokens script', () => {
  let dir;
  let keyFile;
  let env;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'votestorm-keys-'));
    keyFile = path.join(dir, 'key.json');
    const setup = await setupKeys({ issuer: 'https://licenses.example.com', out: keyFile });
    env = setup.env;
  });

  afterEach(() => {
    delete process.env.ANONYMOUS_LICENSE_JWT;
  });

  it('writes a private key and prints only public material for the server environment', () => {
    const privateJwk = JSON.parse(readFileSync(keyFile, 'utf8'));
    expect(privateJwk.d).toBeTruthy();
    expect(env.ALLOWED_LICENSE_ISSUERS).toBe('https://licenses.example.com');
    const jwks = JSON.parse(env.LICENSE_JWKS_JSON);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].d).toBeUndefined();
    expect(jwks.keys[0].kid).toBe(privateJwk.kid);
  });

  it('keeps the private key readable by its owner only (where the platform supports it)', () => {
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o077).toBe(0);
  });

  it('refuses to overwrite an existing key unless forced', async () => {
    await expect(setupKeys({ issuer: 'https://x.test', out: keyFile })).rejects.toThrow('already exists');
    await expect(setupKeys({ issuer: 'https://x.test', out: keyFile, force: true })).resolves.toBeTruthy();
  });

  it('mints licenses the server accepts, with exactly the limits requested', async () => {
    const jwt = await mintLicense({
      issuer: 'https://licenses.example.com', sub: 'acme', name: 'Acme Training', days: 30, hours: 168, maxQuestions: 40, maxAudience: 500, maxStorms: 3, key: keyFile,
    });
    const license = await validateLicenseJwt(jwt, env);
    expect(license).toMatchObject({
      id: 'acme', name: 'Acme Training', tier: 'licensed', stormInactivityHours: 168, maxQuestionsPerStorm: 40, maxAudiencePerStorm: 500, maxActiveStorms: 3,
    });
    const days = (license.expiresAt - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('leaves out limits that are not given, so they stay unlimited', async () => {
    const license = await validateLicenseJwt(await mintLicense({ issuer: 'https://licenses.example.com', sub: 'open', key: keyFile }), env);
    expect(license.maxQuestionsPerStorm).toBeUndefined();
    expect(license.maxAudiencePerStorm).toBeUndefined();
    expect(license.maxActiveStorms).toBeUndefined();
  });

  it('supports a claim namespace the server is configured with', async () => {
    const jwt = await mintLicense({ issuer: 'https://licenses.example.com', sub: 'ns', name: 'Namespaced', maxAudience: 12, namespace: 'https://votestorm.example/', key: keyFile });
    const license = await validateLicenseJwt(jwt, { ...env, LICENSE_CLAIM_NAMESPACE: 'https://votestorm.example/' });
    expect(license).toMatchObject({ name: 'Namespaced', maxAudiencePerStorm: 12 });
  });

  it('is not accepted by a server that trusts a different issuer or key', async () => {
    const jwt = await mintLicense({ issuer: 'https://licenses.example.com', sub: 'x', key: keyFile });
    await expect(validateLicenseJwt(jwt, { ...env, ALLOWED_LICENSE_ISSUERS: 'https://someone-else.test' })).rejects.toThrow('untrusted issuer');
    const otherDir = mkdtempSync(path.join(tmpdir(), 'votestorm-keys-'));
    const other = await setupKeys({ issuer: 'https://licenses.example.com', out: path.join(otherDir, 'k.json') });
    await expect(validateLicenseJwt(jwt, other.env)).rejects.toThrow('Invalid license');
  });

  it('rejects bad input with a clear message', async () => {
    await expect(mintLicense({ sub: 'x', key: keyFile })).rejects.toThrow('--issuer');
    await expect(mintLicense({ issuer: 'https://licenses.example.com', key: keyFile })).rejects.toThrow('--sub');
    await expect(mintLicense({ issuer: 'https://licenses.example.com', sub: 'x', maxAudience: '0', key: keyFile })).rejects.toThrow('--max-audience');
    await expect(mintLicense({ issuer: 'https://licenses.example.com', sub: 'x', key: path.join(dir, 'missing.json') })).rejects.toThrow('Run "setup" first');
  });

  it('mints a license for the anonymous tier with a fixed subject and a long life', async () => {
    const jwt = await mintLicense({ issuer: 'https://licenses.example.com', anonymous: true, hours: 12, maxQuestions: 25, key: keyFile });
    const license = await validateLicenseJwt(jwt, env);
    expect(license).toMatchObject({ id: 'anonymous', name: 'Anonymous', stormInactivityHours: 12, maxQuestionsPerStorm: 25 });
    expect((license.expiresAt - Date.now()) / 86400000).toBeGreaterThan(3600);
  });

  it('prints the anonymous license as a ready-to-paste environment line', async () => {
    const lines = [];
    const cliKey = path.join(dir, 'anon-key.json');
    await main(['setup', '--issuer', 'https://anon.example.com', '--out', cliKey], () => {});
    await main(['mint', '--anonymous', '--issuer', 'https://anon.example.com', '--key', cliKey, '--max-audience', '100'], (line) => lines.push(line));
    expect(lines.join('\n')).toContain('ANONYMOUS_LICENSE_JWT=' + lines[0]);
  });

  it('drives both commands from the command line, printing an activation link when asked', async () => {
    const lines = [];
    const log = (line) => lines.push(line);
    const cliKey = path.join(dir, 'cli-key.json');
    await main(['setup', '--issuer', 'https://cli.example.com', '--out', cliKey], log);
    expect(lines.join('\n')).toContain('ALLOWED_LICENSE_ISSUERS=https://cli.example.com');
    lines.length = 0;
    await main(['mint', '--issuer', 'https://cli.example.com', '--sub', 'cli', '--key', cliKey, '--app-url', 'https://polls.example.com/'], log);
    expect(lines[0].split('.')).toHaveLength(3);
    expect(lines[1]).toContain('https://polls.example.com/#licenseJwt=' + lines[0]);
  });

  describe('loading the private key without a file (for example from 1Password)', () => {
    const issuer = 'https://licenses.example.com';
    const verifies = async (jwt) => expect((await validateLicenseJwt(jwt, env)).id).toBe('vault');

    it('reads it from stdin with --key -', async () => {
      const text = readFileSync(keyFile, 'utf8');
      await verifies(await mintLicense({ issuer, sub: 'vault', key: '-' }, { stdin: async () => text }));
    });

    it('reads it through the 1Password CLI with --key op://...', async () => {
      const text = readFileSync(keyFile, 'utf8');
      let asked;
      await verifies(await mintLicense({ issuer, sub: 'vault', key: 'op://Private/VoteStorm/key' }, { op: async (ref) => ((asked = ref), text) }));
      expect(asked).toBe('op://Private/VoteStorm/key');
    });

    it('reads it from VOTESTORM_LICENSE_KEY when no --key is given, but an explicit --key wins', async () => {
      const text = readFileSync(keyFile, 'utf8');
      await verifies(await mintLicense({ issuer, sub: 'vault' }, { env: { VOTESTORM_LICENSE_KEY: text } }));
      await verifies(await mintLicense({ issuer, sub: 'vault', key: keyFile }, { env: { VOTESTORM_LICENSE_KEY: 'not json' } }));
    });

    it('refuses anything that is not a private JWK, without echoing it', async () => {
      const publicOnly = JSON.stringify(JSON.parse(setupPublic()).keys[0]);
      await expect(mintLicense({ issuer, sub: 'x', key: '-' }, { stdin: async () => 'secret-garbage' })).rejects.toThrow('not a private JWK');
      await expect(mintLicense({ issuer, sub: 'x', key: '-' }, { stdin: async () => publicOnly })).rejects.toThrow('not a private JWK');
    });

    function setupPublic() {
      const privateJwk = JSON.parse(readFileSync(keyFile, 'utf8'));
      const { d, ...pub } = privateJwk;
      return JSON.stringify({ keys: [pub] });
    }
  });
});
