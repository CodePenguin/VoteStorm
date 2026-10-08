import { api, ApiError, type ApiOptions } from '@/api';
import { beginActivity } from '@/composables/useActivity';
import { describeActivity } from '@/lib/activity';
import { importSigner, subtle, toBase64Url } from '@/lib/adminKeys';
import { normalizeStormCode } from '@/lib/stormCode';

export interface AdminSession {
  stormCode: string;
  secret: string;
}

const encoder = new TextEncoder();
const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

// Kept for the session: how far this device's clock is from the server's, learned from the first clock_skew answer.
let clockOffset = 0;
export const resetClockOffset = () => {
  clockOffset = 0;
};

// Importing the key is the slow part, so each secret is imported once. Held in memory only.
const signers = new Map<string, Promise<CryptoKey>>();
const signerFor = (secret: string) => {
  let signer = signers.get(secret);
  if (!signer) {
    signer = importSigner(secret);
    signers.set(secret, signer);
    signer.catch(() => signers.delete(secret));
  }
  return signer;
};

/** The text that is signed. Must match lib/adminAuth.js, which a shared test vector enforces. */
export async function canonicalText(parts: { method: string; functionName: string; stormCode: string; ts: number; body?: string }): Promise<string> {
  const bodyHash = toHex(await subtle().digest('SHA-256', encoder.encode(parts.body ?? '')));
  return ['VOTESTORM-SIG-V1', parts.method.toUpperCase(), parts.functionName, parts.stormCode, String(parts.ts), bodyHash].join('\n');
}

/**
 * An admin call, proven with a signature instead of a secret. The notice (toast) is managed here rather than by api(),
 * so the first attempt of a clock-skew retry does not show a failure for a request that then succeeds.
 */
export async function signedApi<T = unknown>(session: AdminSession, fn: string, options: ApiOptions = {}): Promise<T> {
  const { activity: activityOption, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : '';
  const labels = activityOption === false ? null : (activityOption ?? describeActivity(fn, method, init.body));
  const finish = labels ? beginActivity(labels) : null;
  const stormCode = normalizeStormCode(session.stormCode);

  const attempt = async () => {
    const ts = Date.now() + clockOffset;
    const text = await canonicalText({ method, functionName: fn, stormCode, ts, body });
    const signature = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, await signerFor(session.secret), encoder.encode(text));
    const header = `storm=${stormCode}, ts=${ts}, sig=${toBase64Url(new Uint8Array(signature))}`;
    return api<T>(fn, { ...init, activity: false, headers: { ...(init.headers as Record<string, string> | undefined), 'x-admin-signature': header } });
  };

  try {
    let result: T;
    try {
      result = await attempt();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'clock_skew' || typeof err.serverTime !== 'number') throw err;
      clockOffset = err.serverTime - Date.now();
      result = await attempt();
    }
    finish?.({ ok: true });
    return result;
  } catch (err) {
    finish?.({ ok: false, message: (err as Error)?.message || 'Something went wrong' });
    throw err;
  }
}
