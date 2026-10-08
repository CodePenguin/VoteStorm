import { createHash, createPublicKey, verify } from 'node:crypto';
import { getStormByCode } from './db.js';
import { json } from './http.js';
import { normalizeStormCode } from './stormCode.js';

export const SIGNATURE_WINDOW_MS = 30000;
const VERSION_LINE = 'VOTESTORM-SIG-V1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The exact text the browser signs. Binding method, function, Storm, time and body means none can be reused elsewhere. */
export function canonicalText({ method, functionName, stormCode, ts, body }) {
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  return [VERSION_LINE, String(method).toUpperCase(), functionName, stormCode, String(ts), bodyHash].join('\n');
}

/** `storm=ABCDEFGH, ts=1790000000000, sig=...` into its parts, or null if any part is missing or malformed. */
export function parseSignatureHeader(value) {
  if (typeof value !== 'string') return null;
  const parts = {};
  for (const piece of value.split(',')) {
    const at = piece.indexOf('=');
    if (at === -1) return null;
    parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  const stormCode = normalizeStormCode(parts.storm);
  if (!stormCode || !/^\d{1,16}$/.test(parts.ts ?? '') || !BASE64URL.test(parts.sig ?? '')) return null;
  return { stormCode, ts: Number(parts.ts), sig: parts.sig };
}

/** A P-256 public key from `base64url(0x04 || x || y)`, or null. createPublicKey rejects points that are not on the curve. */
export function parsePublicKey(text) {
  if (typeof text !== 'string' || !BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== 65 || bytes[0] !== 4) return null;
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/** A unique per-Storm value for the table's primary key. Nothing authenticates against it. */
export function publicKeyHash(text) {
  return createHash('sha256').update(Buffer.from(text, 'base64url')).digest('hex');
}

export const isResultsKeyHash = (text) => typeof text === 'string' && /^[0-9a-f]{64}$/.test(text);

const denied = () => json(401, { error: 'Invalid admin credentials' });

/**
 * Checks the signed request for an admin function. Returns { storm } if it is valid, else { response } to send back.
 * Nothing is written: it is a lookup and a signature check. Every failure before the clock check looks the same, so
 * the response does not say whether a Storm exists. The clock-skew answer is only given after a valid signature.
 */
export async function verifyAdmin(event, db, functionName, now = Date.now()) {
  const header = event.headers?.['x-admin-signature'] ?? event.headers?.['X-Admin-Signature'];
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { response: denied() };
  const storm = await getStormByCode(db, parsed.stormCode);
  const key = storm?.admin_public_key ? parsePublicKey(storm.admin_public_key) : null;
  if (!storm || !key) return { response: denied() };
  const text = canonicalText({ method: event.httpMethod, functionName, stormCode: parsed.stormCode, ts: parsed.ts, body: event.body });
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parsed.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { response: denied() };
  if (Math.abs(now - parsed.ts) > SIGNATURE_WINDOW_MS) {
    return { response: json(401, { error: 'This device’s clock is out of step with the server', code: 'clock_skew', serverTime: now }) };
  }
  return { storm };
}
