import type { PairTransport } from '@/lib/pairing';

export interface BusMessage { channel: string; from: number; name: string; data: unknown }

/** An in-memory stand-in for Ably: everyone on a channel hears everyone else (not themselves), a moment later, as a copy. */
export function createBus() {
  type Member = { id: number; channel: string; handler: ((name: string, data: unknown) => void) | null; closed: boolean };
  const members: Member[] = [];
  const log: BusMessage[] = [];
  let nextId = 1;

  function deliver(channel: string, from: number, name: string, data: unknown) {
    log.push({ channel, from, name, data: structuredClone(data) });
    for (const m of members) {
      if (m.channel === channel && m.id !== from && m.handler && !m.closed) {
        const copy = structuredClone(data);
        void Promise.resolve().then(() => !m.closed && m.handler?.(name, copy));
      }
    }
  }

  function open(channel: string): PairTransport & { closed: () => boolean } {
    const me: Member = { id: nextId++, channel, handler: null, closed: false };
    members.push(me);
    return {
      publish: async (name, data) => { if (!me.closed) deliver(channel, me.id, name, data); },
      subscribe: async (handler) => { me.handler = handler; },
      close: () => { me.closed = true; },
      closed: () => me.closed,
    };
  }

  /** A message from someone who is on the channel but is not one of the two devices. */
  const inject = (channel: string, name: string, data: unknown) => deliver(channel, 0, name, data);
  return { open, inject, log, openCount: () => members.length, openMembers: () => members.filter((m) => !m.closed).length };
}
