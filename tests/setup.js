// Every test starts from a valid, complete setup, the same as a developer who has minted their keys: a trusted
// issuer and a license for the anonymous tier. Settings from the developer's own shell or .env are cleared first so
// tests never depend on them.
import { afterEach, vi } from 'vitest';
import { makeIssuer } from './helpers/issuer.js';

// The server opens a database client per request and never closes it (a function instance just ends). In a test run
// that leaves hundreds of native connections open, so every client made during a test is closed when the test ends.
const openClients = vi.hoisted(() => []);
vi.mock('@libsql/client', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createClient: (...args) => {
      const client = real.createClient(...args);
      openClients.push(client);
      return client;
    },
  };
});
afterEach(() => {
  for (const client of openClients.splice(0)) client.close();
});

for (const name of [
  'ALLOWED_LICENSE_ISSUERS', 'LICENSE_JWKS_JSON', 'LICENSE_CLAIM_NAMESPACE', 'LICENSE_AUDIENCE',
  'ANONYMOUS_LICENSE_JWT', 'RATE_LIMIT_SCALE', 'RATE_LIMIT_SALT', 'TURSO_AUTH_TOKEN', 'NETLIFY_DEV',
]) {
  delete process.env[name];
}

const issuer = await makeIssuer('https://licenses.setup.test');
process.env.ALLOWED_LICENSE_ISSUERS = issuer.issuer;
process.env.LICENSE_JWKS_JSON = JSON.stringify(issuer.jwks);
process.env.ANONYMOUS_LICENSE_JWT = issuer.anonymousJwt;
