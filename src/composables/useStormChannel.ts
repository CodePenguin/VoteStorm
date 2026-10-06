import * as Ably from 'ably';
import { api } from '@/api';

export type StormHandlers = Record<string, (data: any) => void>;

export interface StormChannelOptions {
  /** Join the storm's presence set (voters pass their device id). */
  clientId?: string;
  /** Called with the number of distinct connected voters. */
  onPresence?: (count: number) => void;
}

export function subscribeStorm(stormCode: string, handlers: StormHandlers, opts: StormChannelOptions = {}): Ably.Realtime {
  const ably = new Ably.Realtime({
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    authCallback: async (_params, callback) => {
      try {
        const clientPart = opts.clientId ? `&clientId=${encodeURIComponent(opts.clientId)}` : '';
        const tokenRequest = await api<Ably.TokenRequest>(`ably-token?stormCode=${encodeURIComponent(stormCode)}${clientPart}`);
        callback(null, tokenRequest);
      } catch (err) {
        callback(err as Ably.ErrorInfo, null);
      }
    },
  });
  const channel = ably.channels.get(`storm:${stormCode}`);
  for (const [eventName, handler] of Object.entries(handlers)) {
    void channel.subscribe(eventName, (msg) => handler(msg.data));
  }
  if (opts.clientId) {
    channel.presence.enter().catch(() => {});
  }
  if (opts.onPresence) {
    const onPresence = opts.onPresence;
    const refresh = async () => {
      try {
        const members = await channel.presence.get();
        onPresence(new Set(members.map((m) => m.clientId)).size);
      } catch {
        /* presence is best-effort */
      }
    };
    channel.presence.subscribe(refresh).then(refresh).catch(() => {});
  }
  return ably;
}
