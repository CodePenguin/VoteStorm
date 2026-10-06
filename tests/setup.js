// Every test starts from a valid, complete setup, the same as a developer who has minted their keys: a trusted
// issuer and a license for the anonymous tier. Settings from the developer's own shell or .env are cleared first so
// tests never depend on them.
import { makeIssuer } from './helpers/issuer.js';

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
