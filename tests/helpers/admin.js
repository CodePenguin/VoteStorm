import { webcrypto, randomBytes } from 'node:crypto';
import { canonicalText, publicKeyHash } from '../../lib/adminAuth.js';
import { generateStormCode, hashResultsKey } from '../../lib/stormCode.js';

const { subtle } = webcrypto;
export const ANONYMOUS_LICENSE_JSON = '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}';

/** A presenter: a real P-256 key pair, and the means to sign requests the way the browser does. */
export async function makeAdmin() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const resultsKey = randomBytes(12).toString('hex');
  const admin = {
    publicKey,
    resultsKey,
    resultsKeyHash: hashResultsKey(resultsKey),
    stormCode: null,
    async sign(functionName, event, { ts = Date.now(), stormCode = admin.stormCode } = {}) {
      const text = canonicalText({ method: event.httpMethod, functionName, stormCode, ts, body: event.body });
      const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(text))).toString('base64url');
      return { ...event, headers: { ...event.headers, 'x-admin-signature': `storm=${stormCode}, ts=${ts}, sig=${sig}` } };
    },
    async call(handler, functionName, event, opts) {
      return handler(await admin.sign(functionName, event, opts));
    },
  };
  return admin;
}

/** Inserts a live Storm owned by a fresh presenter and returns that presenter, with `stormCode` set. */
export async function seedStorm(db, { licenseJson = ANONYMOUS_LICENSE_JSON, status = 'lobby', ...columns } = {}) {
  const admin = await makeAdmin();
  admin.stormCode = generateStormCode();
  const row = {
    admin_key_hash: publicKeyHash(admin.publicKey), admin_public_key: admin.publicKey, storm_code: admin.stormCode, status,
    created_at: Date.now(), license_json: licenseJson, results_key_hash: admin.resultsKeyHash, ...columns,
  };
  const names = Object.keys(row);
  await db.execute({ sql: `INSERT INTO storms (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, args: Object.values(row) });
  return admin;
}
