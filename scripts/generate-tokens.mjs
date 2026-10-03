// Self-hosted license issuing for VoteStorm. Any other issuer (Auth0, Keycloak, ...) works too; see docs/licensing.md.
//
//   node scripts/generate-tokens.mjs setup --issuer https://licenses.example.com [--out votestorm-license-key.json]
//   node scripts/generate-tokens.mjs mint --issuer https://licenses.example.com --sub acme --name "Acme Training" \
//        --days 365 [--hours 168] [--max-questions 40] [--max-audience 500] [--max-rooms 3] [--key votestorm-license-key.json]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';

const DEFAULT_KEY_FILE = 'votestorm-license-key.json';

/** Creates an ES256 signing key pair. The private key is written to `out`; the public half goes in the server's environment. */
export async function setupKeys({ issuer, out = DEFAULT_KEY_FILE, force = false }) {
  if (!issuer) throw new Error('--issuer is required (the URL that identifies you as the license issuer)');
  if (existsSync(out) && !force) throw new Error(`${out} already exists. Use --force to replace it (this invalidates every license signed with it).`);
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `votestorm-${Date.now().toString(36)}`;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  await writeFile(out, JSON.stringify(privateJwk, null, 2) + '\n', { mode: 0o600 });
  return {
    keyFile: out,
    env: {
      ALLOWED_LICENSE_ISSUERS: issuer,
      LICENSE_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
    },
  };
}

function positive(name, value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
}

/** Signs a license. Omitted limits are left out of the token, which means unlimited. */
export async function mintLicense({
  issuer, sub, name, days, hours, maxQuestions, maxAudience, maxRooms, namespace = '', key = DEFAULT_KEY_FILE,
}) {
  if (!issuer) throw new Error('--issuer is required and must match ALLOWED_LICENSE_ISSUERS exactly');
  if (!sub) throw new Error('--sub is required (a stable id for the licensee; rooms are counted per sub)');
  const validDays = positive('--days', days) ?? 365;
  if (!existsSync(key)) throw new Error(`Signing key ${key} not found. Run "setup" first.`);
  const privateJwk = JSON.parse(await readFile(key, 'utf8'));
  const claims = {};
  const set = (claim, value) => {
    if (value !== undefined) claims[namespace + claim] = value;
  };
  set('name', name);
  set('roomInactivityHours', positive('--hours', hours));
  set('maxQuestionsPerRoom', positive('--max-questions', maxQuestions));
  set('maxAudiencePerRoom', positive('--max-audience', maxAudience));
  set('maxActiveRooms', positive('--max-rooms', maxRooms));
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: privateJwk.kid })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(`${validDays}d`)
    .sign(await importJWK(privateJwk, 'ES256'));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      i++;
    }
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { command, options } = parseArgs(argv);
  if (command === 'setup') {
    const { keyFile, env } = await setupKeys({ issuer: options.issuer, out: options.out, force: !!options.force });
    log(`Private signing key written to ${keyFile}. Keep it secret and back it up; it is needed to issue licenses.\n`);
    log('Add these to the server environment (.env or your host settings):\n');
    log(`ALLOWED_LICENSE_ISSUERS=${env.ALLOWED_LICENSE_ISSUERS}`);
    log(`LICENSE_JWKS_JSON=${env.LICENSE_JWKS_JSON}`);
    return;
  }
  if (command === 'mint') {
    const jwt = await mintLicense(options);
    log(jwt);
    if (options.appUrl) log(`\nActivation link:\n${String(options.appUrl).replace(/\/$/, '')}/#licenseJwt=${jwt}`);
    return;
  }
  log('Usage:\n  node scripts/generate-tokens.mjs setup --issuer <url> [--out <file>] [--force]\n  node scripts/generate-tokens.mjs mint --issuer <url> --sub <id> [--name <text>] [--days N] [--hours N]\n    [--max-questions N] [--max-audience N] [--max-rooms N] [--namespace <prefix>] [--key <file>] [--app-url <url>]');
  process.exitCode = command ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
