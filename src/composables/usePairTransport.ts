import * as Ably from 'ably';
import { ApiError, api } from '@/api';
import { PairLicenseError, PairRateLimitError, type PairTransport } from '@/lib/pairing';

export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A refusal from the token endpoint that trying again will not fix: a missing (403) or invalid (401) license, since syncing
 * is licensed, or too many tokens for now (429, with the wait the server gave). Anything else is left to Ably as a
 * connection problem.
 */
function refusalFrom(err: unknown): Error | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 401 || err.status === 403) return new PairLicenseError();
  if (err.status === 429) return new PairRateLimitError(err.retryAfter);
  return null;
}

/** The Ably end of a pairing: one private channel, no echo of our own messages, a token for that channel only. */
export function openPairTransport(channelId: string): PairTransport {
  // A refusal is remembered: it ends a pending subscribe at once instead of waiting out the connect timeout, and Ably's own
  // retries are answered with it without asking the server again (each ask would count against the limit).
  let refusal: Error | null = null;
  let refuse: ((err: Error) => void) | null = null;
  const ably = new Ably.Realtime({
    echoMessages: false,
    authCallback: async (_params, callback) => {
      if (refusal) {
        callback(refusal as unknown as Ably.ErrorInfo, null);
        return;
      }
      try {
        // The license goes with this request (api adds it for pair-token), and the server counts the limit against it.
        callback(null, await api<Ably.TokenRequest>(`pair-token?id=${encodeURIComponent(channelId)}`));
      } catch (err) {
        const refused = refusalFrom(err);
        if (refused) {
          refusal = refused;
          refuse?.(refused);
        }
        callback(err as Ably.ErrorInfo, null);
      }
    },
  });
  const channel = ably.channels.get(`pair:${channelId}`);
  return {
    async publish(name, data) {
      await channel.publish(name, data);
    },
    async subscribe(handler) {
      // Attaching is what makes later messages arrive. A blocked connection or a refused token would otherwise leave this pending.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(refusal ?? new Error('Could not connect')), CONNECT_TIMEOUT_MS);
      });
      const refused = new Promise<never>((_, reject) => {
        refuse = reject;
        if (refusal) reject(refusal);
      });
      const attach = channel.subscribe((msg) => handler(msg.name ?? '', msg.data));
      // After a timeout nobody awaits the attach any more, so its own later failure must not surface as an unhandled rejection.
      attach.catch(() => {});
      try {
        await Promise.race([attach, timeout, refused]).catch((err) => {
          // Ably reports a failed token fetch in its own words; what the server said is what this device can act on.
          throw refusal ?? err;
        });
      } finally {
        clearTimeout(timer);
        refuse = null;
      }
    },
    close() {
      ably.close();
    },
  };
}
