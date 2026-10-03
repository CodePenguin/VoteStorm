import * as Ably from 'ably';
import { api } from '@/api';

export type RoomHandlers = Record<string, (data: any) => void>;

export interface RoomChannelOptions {
  /** Join the room's presence set (voters pass their device id). */
  clientId?: string;
  /** Called with the number of distinct connected voters. */
  onPresence?: (count: number) => void;
}

export function subscribeRoom(roomCode: string, handlers: RoomHandlers, opts: RoomChannelOptions = {}): Ably.Realtime {
  const ably = new Ably.Realtime({
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    authCallback: async (_params, callback) => {
      try {
        const clientPart = opts.clientId ? `&clientId=${encodeURIComponent(opts.clientId)}` : '';
        const tokenRequest = await api<Ably.TokenRequest>(`ably-token?roomCode=${encodeURIComponent(roomCode)}${clientPart}`);
        callback(null, tokenRequest);
      } catch (err) {
        callback(err as Ably.ErrorInfo, null);
      }
    },
  });
  const channel = ably.channels.get(`room:${roomCode}`);
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
