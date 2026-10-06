import { createHash } from 'node:crypto';
import { json } from './http.js';

// Fixed-window counters kept in the database, so the limits hold across serverless instances. Limits are generous
// on purpose: a whole conference audience can share one public IP address. Set RATE_LIMIT_SCALE to scale every limit
// (2 doubles them, 0 turns rate limiting off).
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const LIMITS = {
  createStorm: { limit: 20, windowMs: HOUR },
  addQuestion: { limit: 120, windowMs: MINUTE },
  voteByIp: { limit: 2000, windowMs: MINUTE },
  voteByDevice: { limit: 30, windowMs: MINUTE },
  realtimeToken: { limit: 600, windowMs: MINUTE },
};

/** The caller's address as Netlify reports it; null when it cannot be determined (local development, tests). */
export function clientIp(event) {
  const h = event?.headers ?? {};
  const forwarded = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : null;
  return h['x-nf-client-connection-ip'] || h['client-ip'] || forwarded || null;
}

const bucketFor = (name, who) => `${name}:${createHash('sha256').update(`${process.env.RATE_LIMIT_SALT ?? 'votestorm'}|${who}`).digest('hex').slice(0, 20)}`;

/**
 * Counts one request against `name` for `who` (an IP or a device id). Returns null when the request may go
 * ahead, or a ready-to-send 429 response when it is over the limit. Only a hash of the address is stored.
 */
export async function rateLimit(db, name, who, { now = Date.now(), env = process.env } = {}) {
  const scale = env.RATE_LIMIT_SCALE === undefined ? 1 : Number(env.RATE_LIMIT_SCALE);
  const rule = LIMITS[name];
  if (!who || !rule || !Number.isFinite(scale) || scale <= 0) return null;
  const limit = Math.max(1, Math.floor(rule.limit * scale));
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const result = await db.execute({
    sql: `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    args: [bucketFor(name, who), windowStart],
  });
  if (Number(result.rows[0].count) <= limit) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000));
  return json(429, { error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' }, { 'retry-after': String(retryAfter) });
}

export const rateLimitByIp = (db, event, name, options) => rateLimit(db, name, clientIp(event), options);
