// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { AFTER_REPLY_MS, CODE_TTL_MS, DONE_SEND_MS, HELLO_WAIT_MS, PairLicenseError, PairRateLimitError, startHost, startJoin, type HostState, type JoinState, type OpenTransport } from '@/lib/pairing';
import { mergeLists, type RecentStorm } from '@/lib/recentStorms';
import { toBase64Url } from '@/lib/adminKeys';
import {
  MAX_MESSAGE_BYTES, buildDone, buildPayload, checkTag, deriveFromCode, makeEphemeral, makeTag, parsePublicKey, seal, sessionKey, type Sealed,
} from '@/lib/pairCrypto';
import { createBus } from '../helpers/pairBus';

// WebCrypto resolves on real threads, which the fake clock knows nothing about. So every SubtleCrypto call goes through a
// wrapper that counts the calls still in flight: the tests can then wait for a state to arrive (`until`), or for everything
// to be finished (`settle`: nothing in flight for many event-loop turns in a row) before asserting that something did NOT happen.
let inFlight = 0;
const SUBTLE = ['decrypt', 'deriveBits', 'deriveKey', 'digest', 'encrypt', 'exportKey', 'generateKey', 'importKey', 'sign', 'verify'] as const;
const trackedSubtle = Object.fromEntries(
  SUBTLE.map((m) => [m, (...args: unknown[]) => {
    inFlight++;
    let pending: Promise<unknown>;
    try {
      pending = (webcrypto.subtle[m] as (...a: unknown[]) => Promise<unknown>).apply(webcrypto.subtle, args);
    } catch (err) {
      // A call that throws at once (bad arguments) never settles a promise, so it is counted out here.
      inFlight--;
      throw err;
    }
    return pending.finally(() => inFlight--);
  }]),
) as unknown as SubtleCrypto;

beforeAll(() => vi.stubGlobal('crypto', { subtle: trackedSubtle, getRandomValues: <T extends ArrayBufferView>(a: T) => webcrypto.getRandomValues(a as never) as T }));
afterAll(() => vi.unstubAllGlobals());
/** Every session a test started, cancelled afterwards so nothing from one test resumes inside the next. */
const started: { cancel(): void }[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  started.splice(0).forEach((s) => s.cancel());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// One real event-loop turn, flushing promises, without moving the fake clock: the timer tests advance it exactly.
// (setImmediate and hrtime are captured before any test fakes them.)
const realSetImmediate = globalThis.setImmediate;
const realHrtime = process.hrtime.bigint.bind(process.hrtime);
const realMs = () => Number(realHrtime() / 1_000_000n);
const step = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((r) => realSetImmediate(r));
};
/** Waits until `pred` holds, failing the test if it never does. */
const until = async (pred: () => boolean, ms = 3000) => {
  const end = realMs() + ms;
  while (!pred()) {
    if (realMs() > end) throw new Error('timed out waiting');
    await step();
  }
};
/** Waits until no crypto is in flight and nothing has started for 20 turns: whatever was going to happen has happened. */
const settle = async () => {
  let quiet = 0;
  await until(() => {
    quiet = inFlight === 0 ? quiet + 1 : 0;
    return quiet >= 20;
  });
};

const CODE = 'ABCDE12345';
const OTHER_CODE = 'ZYXWV98765';
const NOW = 10_000;
const storm = (code: string, at: number, name: string | null = null): RecentStorm => ({ stormCode: code, secret: `SECRET-${code}`.padEnd(128, 'x'), name, lastOpenedAt: at });

/** A device's saved list, standing in for localStorage. */
function device(initial: RecentStorm[]) {
  let list = [...initial];
  return {
    list: () => list,
    merge: (incoming: RecentStorm[]) => { const m = mergeLists(list, incoming, NOW); list = m.merged; return m.result; },
  };
}
const codes = (d: ReturnType<typeof device>) => d.list().map((e) => e.stormCode).sort();

type Bus = ReturnType<typeof createBus>;

function host(bus: Bus, d: ReturnType<typeof device>, code = CODE, open: OpenTransport = bus.open) {
  const states: HostState[] = [];
  const h = startHost({ code, storms: d.list(), open, merge: d.merge, onState: (st) => states.push(st) });
  started.push(h);
  const last = () => states[states.length - 1];
  return { h, states, last, reached: (phase: HostState['phase']) => until(() => last().phase === phase) };
}
function join(bus: Bus, d: ReturnType<typeof device>, code = CODE, open: OpenTransport = bus.open) {
  const states: JoinState[] = [];
  const j = startJoin({ code, open, merge: d.merge, list: d.list, onState: (st) => states.push(st) });
  started.push(j);
  const last = () => states[states.length - 1];
  return { j, states, last, reached: (phase: JoinState['phase']) => until(() => last().phase === phase) };
}
const sent = (bus: Bus, name: string) => bus.log.filter((m) => m.name === name);

/**
 * Wraps `open` so a test can call a device's message handler directly (as a message arriving late, or at an awkward moment,
 * would), rewrite what it sends, and see whether it tried to send anything after its transport was closed.
 */
function spy(open: OpenTransport, rewrite?: (name: string, data: unknown) => unknown) {
  const handlers: ((name: string, data: unknown) => void)[] = [];
  const lateSends: string[] = [];
  const closed: boolean[] = [];
  const wrapped: OpenTransport = (channelId) => {
    const t = open(channelId);
    const i = closed.push(false) - 1;
    return {
      publish: (name, data) => {
        if (closed[i]) lateSends.push(name);
        return t.publish(name, rewrite ? rewrite(name, data) : data);
      },
      subscribe: (handler) => {
        handlers.push(handler);
        return t.subscribe(handler);
      },
      close: () => {
        closed[i] = true;
        t.close();
      },
    };
  };
  return { open: wrapped, handlers, lateSends, opened: () => closed.length, allClosed: () => closed.every(Boolean) };
}

/** Flips the first character of a sealed message's ciphertext. */
const corrupt = (data: unknown) => {
  const s = data as Sealed;
  return { ...s, ct: (s.ct[0] === 'A' ? 'B' : 'A') + s.ct.slice(1) };
};

/** Seals text that is not JSON, the way `seal` would seal JSON. */
async function sealRaw(key: CryptoKey, channelId: string, purpose: 'data' | 'done', text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${channelId}|${purpose}`) }, key, enc.encode(text));
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

/** Shaped like a sealed message and just over 64 KB, so only the size check can turn it away before it is opened. */
const oversized = (): Sealed => ({ iv: toBase64Url(new Uint8Array(12)), ct: 'A'.repeat(MAX_MESSAGE_BYTES - 10) });

/** A device played by hand with the pairCrypto helpers: on the code's channel, recording everything it hears. */
async function peer(bus: Bus, code = CODE) {
  const keys = await deriveFromCode(code);
  const t = bus.open(keys.channelId);
  const inbox: { name: string; data: unknown }[] = [];
  await t.subscribe((name, data) => inbox.push({ name, data }));
  const mine = await makeEphemeral();
  const got = async <T = Record<string, string>>(name: string): Promise<T> => {
    await until(() => inbox.some((m) => m.name === name));
    return inbox.find((x) => x.name === name)!.data as T;
  };
  return { keys, t, inbox, mine, got };
}

/** Plays the joiner: the hello it would send, and (once a reply is in) the session key, checking the reply's tag as the joiner does. */
async function handJoiner(bus: Bus) {
  const p = await peer(bus);
  const hello = { pub: toBase64Url(p.mine.pub), tag: await makeTag(p.keys.authKey, 'R', p.mine.pub) };
  return {
    ...p,
    hello,
    async sayHello() {
      await p.t.publish('hello', hello);
    },
    async keyFromReply() {
      const reply = await p.got('reply');
      const pubS = parsePublicKey(reply.pub)!;
      expect(await checkTag(p.keys.authKey, reply.tag, 'S', pubS, p.mine.pub)).toBe(true);
      return sessionKey(p.mine, pubS, p.mine.pub, pubS);
    },
  };
}

/** Plays the host: a reply to the joiner's hello and the session key it gives. */
async function handHost(bus: Bus) {
  const p = await peer(bus);
  return {
    ...p,
    async replyTo() {
      const hello = await p.got('hello');
      const pubR = parsePublicKey(hello.pub)!;
      expect(await checkTag(p.keys.authKey, hello.tag, 'R', pubR)).toBe(true);
      const reply = { pub: toBase64Url(p.mine.pub), tag: await makeTag(p.keys.authKey, 'S', p.mine.pub, pubR) };
      return { reply, key: await sessionKey(p.mine, pubR, pubR, p.mine.pub) };
    },
    async answer() {
      const { reply, key } = await this.replyTo();
      await p.t.publish('reply', reply);
      return key;
    },
  };
}

/** A real host driven to `sending` by a hand-played joiner, which then holds the session key. */
async function hostAtSending(bus: Bus, a: ReturnType<typeof device>, open: OpenTransport = bus.open) {
  const h = host(bus, a, CODE, open);
  await h.reached('waiting');
  const p = await handJoiner(bus);
  await p.sayHello();
  const key = await p.keyFromReply();
  await h.reached('ready');
  await h.h.confirm();
  await p.got('data');
  return { h, p, key };
}

/** A real joiner driven to `receiving` by a hand-played host, which then holds the session key. */
async function joinerAtReceiving(bus: Bus, b: ReturnType<typeof device>, open: OpenTransport = bus.open) {
  const p = await handHost(bus);
  const j = join(bus, b, CODE, open);
  await j.reached('waiting');
  const key = await p.answer();
  await j.reached('receiving');
  return { j, p, key };
}

describe('pairing', () => {
  it('syncs two different lists both ways, ends with the same list on both, closes, and leaves no timer', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000, 'Town hall'), storm('SAME3333', 1000)]);
    const b = device([storm('BBBB4444', 3000), storm('SAME3333', 1500)]);
    const h = host(bus, a);
    await h.reached('waiting');
    const j = join(bus, b);
    await h.reached('ready');
    expect(h.last()).toMatchObject({ phase: 'ready', count: 2 });
    await h.h.confirm();
    await h.reached('done');
    await j.reached('done');
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'waiting', 'ready', 'sending', 'done']);
    expect(j.states.map((s) => s.phase)).toEqual(['connecting', 'waiting', 'receiving', 'done']);
    expect(codes(a)).toEqual(['AAAA2222', 'BBBB4444', 'SAME3333']);
    expect(codes(b)).toEqual(codes(a));
    expect(a.list().find((e) => e.stormCode === 'SAME3333')?.lastOpenedAt).toBe(1500);
    expect(j.last()).toMatchObject({ result: { added: 1, updated: 0, kept: 1 } }); // AAAA2222 is new to the joiner; SAME3333 has the same key
    // BBBB4444 is new to the host; AAAA2222 comes back as it was, and SAME3333 is newer but has the same key: both count as kept.
    expect(h.last()).toMatchObject({ result: { added: 1, updated: 0, kept: 2 } });
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never puts the code, a secret or a name on the wire', async () => {
    const bus = createBus();
    const h = host(bus, device([storm('AAAA2222', 2000, 'Town hall')]));
    await h.reached('waiting');
    join(bus, device([storm('BBBB4444', 3000, 'Workshop')]));
    await h.reached('ready');
    await h.h.confirm();
    await h.reached('done');
    const wire = JSON.stringify(bus.log);
    expect(wire).not.toContain(CODE);
    expect(wire).not.toContain('SECRET-');
    expect(wire).not.toContain('Town hall');
    expect(wire).not.toContain('Workshop');
    expect(bus.log.map((m) => m.name)).toEqual(['hello', 'reply', 'data', 'done']);
    expect(bus.log.every((m) => /^[0-9a-f]{64}$/.test(m.channel))).toBe(true);
  });

  it('works when the host holds nothing (a new device is the usual case)', async () => {
    const bus = createBus();
    const a = device([]);
    const b = device([storm('BBBB4444', 3000)]);
    const h = host(bus, a);
    await h.reached('waiting');
    join(bus, b);
    await h.reached('ready');
    expect(h.last()).toMatchObject({ phase: 'ready', count: 0 });
    await h.h.confirm();
    await h.reached('done');
    expect(codes(a)).toEqual(['BBBB4444']);
    expect(h.last()).toMatchObject({ phase: 'done', result: { added: 1, updated: 0, kept: 0 } });
  });

  it('a wrong code finds nobody, leaves the host waiting, and a hello tagged with the wrong code ends the host', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000)]);
    const h = host(bus, a);
    await h.reached('waiting');
    const j = join(bus, device([]), OTHER_CODE);
    await j.reached('waiting');
    await vi.advanceTimersByTimeAsync(HELLO_WAIT_MS);
    expect(j.last()).toEqual({ phase: 'failed', reason: 'no_answer' });
    await settle();
    expect(h.last().phase).toBe('waiting');
    expect(sent(bus, 'reply')).toHaveLength(0);

    // Only the code is wrong: the tag covers exactly what a real joiner's would, under the other code's key.
    const wrong = await deriveFromCode(OTHER_CODE);
    const { channelId } = await deriveFromCode(CODE);
    const pub = (await makeEphemeral()).pub;
    bus.inject(channelId, 'hello', { pub: toBase64Url(pub), tag: await makeTag(wrong.authKey, 'R', pub) });
    await h.reached('failed');
    expect(h.last()).toEqual({ phase: 'failed', reason: 'wrong_code' });
    expect(sent(bus, 'reply')).toHaveLength(0);
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(codes(a)).toEqual(['AAAA2222']);
  });

  it('a forged reply ends the joiner with wrong_code', async () => {
    const bus = createBus();
    const j = join(bus, device([]));
    await j.reached('waiting');
    await until(() => sent(bus, 'hello').length === 1);
    // Tagged over the host key and this joiner's own key, as a real reply is, but under the other code's key.
    const joinerPub = parsePublicKey((sent(bus, 'hello')[0].data as { pub: string }).pub)!;
    const wrong = await deriveFromCode(OTHER_CODE);
    const { channelId } = await deriveFromCode(CODE);
    const pub = (await makeEphemeral()).pub;
    bus.inject(channelId, 'reply', { pub: toBase64Url(pub), tag: await makeTag(wrong.authKey, 'S', pub, joinerPub) });
    await j.reached('failed');
    expect(j.last()).toEqual({ phase: 'failed', reason: 'wrong_code' });
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('a correctly tagged key that is not a point on the curve is invalid, on both sides', () => {
    const offCurve = () => {
      const pub = new Uint8Array(65);
      pub[0] = 4;
      pub[1] = 1;
      return pub;
    };

    it('the host', async () => {
      const bus = createBus();
      const h = host(bus, device([]));
      await h.reached('waiting');
      const p = await peer(bus);
      const pub = offCurve();
      await p.t.publish('hello', { pub: toBase64Url(pub), tag: await makeTag(p.keys.authKey, 'R', pub) });
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(sent(bus, 'reply')).toHaveLength(0);
    });

    it('the joiner', async () => {
      const bus = createBus();
      const p = await peer(bus);
      const j = join(bus, device([]));
      await j.reached('waiting');
      const joinerPub = parsePublicKey((await p.got('hello')).pub)!;
      const pub = offCurve();
      await p.t.publish('reply', { pub: toBase64Url(pub), tag: await makeTag(p.keys.authKey, 'S', pub, joinerPub) });
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'invalid' });
    });
  });

  it('answers only the first hello, even when a second arrives while the first is being checked', async () => {
    const bus = createBus();
    const h = host(bus, device([storm('AAAA2222', 2000)]));
    await h.reached('waiting');
    const first = await handJoiner(bus);
    const second = await handJoiner(bus);
    // Both in the same turn: the second arrives while the first is still being verified.
    await first.sayHello();
    await second.sayHello();
    await h.reached('ready');
    await settle();
    expect(h.last()).toMatchObject({ phase: 'ready', count: 1 });
    expect(sent(bus, 'reply')).toHaveLength(1);
    await first.keyFromReply(); // the reply is for the first joiner's key

    // And once ready, a further (properly tagged) hello changes nothing.
    const third = await handJoiner(bus);
    await third.sayHello();
    await settle();
    expect(h.last().phase).toBe('ready');
    expect(h.states.filter((s) => s.phase === 'ready')).toHaveLength(1);
    expect(sent(bus, 'reply')).toHaveLength(1);
  });

  it('tampered data fails the joiner without touching its list, and the host then times out', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000)]);
    const b = device([storm('BBBB4444', 3000)]);
    const s = spy(bus.open, (name, data) => (name === 'data' ? corrupt(data) : data));
    const h = host(bus, a, CODE, s.open);
    await h.reached('waiting');
    const j = join(bus, b);
    await h.reached('ready');
    await h.h.confirm();
    await j.reached('failed');
    expect(j.last()).toEqual({ phase: 'failed', reason: 'invalid' });
    expect(codes(b)).toEqual(['BBBB4444']);
    await settle();
    expect(h.last().phase).toBe('sending');
    await vi.advanceTimersByTimeAsync(AFTER_REPLY_MS);
    expect(h.last()).toEqual({ phase: 'failed', reason: 'timeout' });
    expect(codes(a)).toEqual(['AAAA2222']);
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a tampered done fails the host without touching its list', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000)]);
    const b = device([storm('BBBB4444', 3000)]);
    const h = host(bus, a);
    await h.reached('waiting');
    const s = spy(bus.open, (name, data) => (name === 'done' ? corrupt(data) : data));
    const j = join(bus, b, CODE, s.open);
    await h.reached('ready');
    await h.h.confirm();
    await j.reached('done');
    await h.reached('failed');
    expect(h.last()).toEqual({ phase: 'failed', reason: 'invalid' });
    expect(codes(a)).toEqual(['AAAA2222']);
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('hostile payloads', () => {
    const big = { ...storm('BIG22222', 1000), secret: 'x'.repeat(5000) };
    const many = Array.from({ length: 51 }, (_, i) => storm(`MANY${i}`, 1000 + i));
    const cases: [string, { value?: unknown; raw?: string }][] = [
      ['a different version', { value: { v: 2, storms: [] } }],
      ['51 entries', { value: { v: 1, storms: many } }],
      ['a giant secret', { value: { v: 1, storms: [big] } }],
      ['plain text instead of JSON', { raw: 'not json at all' }],
      ['an envelope over 64 KB', { value: { v: 1, storms: [], pad: 'x'.repeat(70_000) } }],
    ];

    it('the hand-played host is a real one: a well-formed payload is merged (the control for the cases below)', async () => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const { j, p, key } = await joinerAtReceiving(bus, b);
      await p.t.publish('data', await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)])));
      await j.reached('done');
      expect(j.last()).toEqual({ phase: 'done', result: { added: 1, updated: 0, kept: 0 } });
      expect(codes(b)).toEqual(['AAAA2222', 'BBBB4444']);
      expect(sent(bus, 'done')).toHaveLength(1);
    });

    it.each(cases)('the joiner rejects %s', async (_label, bad) => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const before = structuredClone(b.list());
      const { j, p, key } = await joinerAtReceiving(bus, b);
      const sealed = bad.raw !== undefined ? await sealRaw(key, p.keys.channelId, 'data', bad.raw) : await seal(key, p.keys.channelId, 'data', bad.value);
      await p.t.publish('data', sealed);
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(b.list()).toEqual(before);
      expect(sent(bus, 'done')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the joiner turns away data over 64 KB without opening it', async () => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const { j, p } = await joinerAtReceiving(bus, b);
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      await p.t.publish('data', oversized());
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(decrypt).not.toHaveBeenCalled();
      expect(codes(b)).toEqual(['BBBB4444']);
    });

    it.each(cases)('the host rejects a done holding %s', async (_label, bad) => {
      const bus = createBus();
      const a = device([storm('AAAA2222', 2000)]);
      const before = structuredClone(a.list());
      const { h, p, key } = await hostAtSending(bus, a);
      const value = { result: { added: 0, updated: 0, kept: 0 }, list: bad.value };
      const sealed = bad.raw !== undefined ? await sealRaw(key, p.keys.channelId, 'done', bad.raw) : await seal(key, p.keys.channelId, 'done', value);
      await p.t.publish('done', sealed);
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(a.list()).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the host turns away a done over 64 KB without opening it', async () => {
      const bus = createBus();
      const a = device([storm('AAAA2222', 2000)]);
      const { h, p } = await hostAtSending(bus, a);
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
      await p.t.publish('done', oversized());
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(decrypt).not.toHaveBeenCalled();
      expect(codes(a)).toEqual(['AAAA2222']);
    });
  });

  it('the host merges a done once, even when it arrives twice', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000)]);
    const merge = vi.fn(a.merge);
    const states: HostState[] = [];
    const h = startHost({ code: CODE, storms: a.list(), open: bus.open, merge, onState: (st) => states.push(st) });
    started.push(h);
    await until(() => states[states.length - 1].phase === 'waiting');
    const p = await handJoiner(bus);
    await p.sayHello();
    const key = await p.keyFromReply();
    await until(() => states[states.length - 1].phase === 'ready');
    await h.confirm();
    await p.got('data');
    const done = await seal(key, p.keys.channelId, 'done', buildDone({ added: 0, updated: 0, kept: 1 }, [storm('BBBB4444', 3000), storm('AAAA2222', 2000)]));
    await p.t.publish('done', done);
    await p.t.publish('done', done);
    await until(() => states[states.length - 1].phase === 'done');
    await settle();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(states.filter((s) => s.phase === 'done')).toHaveLength(1);
    expect(codes(a)).toEqual(['AAAA2222', 'BBBB4444']);
  });

  it('the host sends at most 50 Storms, in an envelope under 64 KB', async () => {
    const bus = createBus();
    const sixty = Array.from({ length: 60 }, (_, i) => storm(`LONG${i}`, 1000 + i, 'N'.repeat(100)));
    const h = host(bus, device(sixty));
    await h.reached('waiting');
    const b = device([]);
    join(bus, b);
    await h.reached('ready');
    expect(h.last()).toMatchObject({ phase: 'ready', count: 50 });
    await h.h.confirm();
    await h.reached('done');
    const data = sent(bus, 'data')[0].data;
    expect(JSON.stringify(data).length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(b.list()).toHaveLength(50);
  });

  it('a joiner whose own list holds an entry the host would refuse sends back the rest, and the sync completes', async () => {
    const bus = createBus();
    const a = device([storm('AAAA2222', 2000)]);
    // Only a corrupted local list could hold this: what arrives from another device is bounded on the way in.
    const b = device([{ ...storm('HUGE2222', 3000), secret: 'x'.repeat(70_000) }, storm('BBBB4444', 2500)]);
    const h = host(bus, a);
    await h.reached('waiting');
    const j = join(bus, b);
    await h.reached('ready');
    await h.h.confirm();
    await j.reached('done');
    expect(j.last()).toEqual({ phase: 'done', result: { added: 1, updated: 0, kept: 0 } });
    await h.reached('done');
    expect(codes(a)).toEqual(['AAAA2222', 'BBBB4444']);
    expect(JSON.stringify(sent(bus, 'done')[0].data).length).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('a joiner whose done never finishes sending still reports done after a few seconds, and leaves no timer', async () => {
    const bus = createBus();
    const b = device([]);
    let sending = false;
    const stuck: OpenTransport = (channelId) => {
      const t = bus.open(channelId);
      return {
        ...t,
        publish: (name, data) => {
          if (name !== 'done') return t.publish(name, data);
          sending = true;
          return new Promise<void>(() => {});
        },
      };
    };
    const { j, p, key } = await joinerAtReceiving(bus, b, stuck);
    await p.t.publish('data', await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)])));
    await until(() => sending);
    await vi.advanceTimersByTimeAsync(DONE_SEND_MS - 100);
    expect(j.last().phase).toBe('receiving');
    await vi.advanceTimersByTimeAsync(100);
    await j.reached('done');
    expect(j.last()).toEqual({ phase: 'done', result: { added: 1, updated: 0, kept: 0 } });
    expect(codes(b)).toEqual(['AAAA2222']);
    expect(bus.openMembers()).toBe(1); // only the hand-played host is still on the channel
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a host whose own key pair cannot be made fails with connection, not invalid', async () => {
    const bus = createBus();
    const h = host(bus, device([]));
    await h.reached('waiting');
    const p = await handJoiner(bus);
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValueOnce(new Error('no crypto'));
    await p.sayHello();
    await h.reached('failed');
    expect(h.last()).toEqual({ phase: 'failed', reason: 'connection' });
    expect(sent(bus, 'reply')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a code nobody uses expires, closing and leaving no timer', async () => {
    const bus = createBus();
    const h = host(bus, device([]));
    await h.reached('waiting');
    expect(h.last()).toEqual({ phase: 'waiting', expiresAt: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(CODE_TTL_MS - 500);
    expect(h.last().phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.last()).toEqual({ phase: 'failed', reason: 'expired' });
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a host that is ready but never confirmed times out', async () => {
    const bus = createBus();
    const h = host(bus, device([]));
    await h.reached('waiting');
    const p = await handJoiner(bus);
    await p.sayHello();
    await h.reached('ready');
    await vi.advanceTimersByTimeAsync(AFTER_REPLY_MS);
    expect(h.last()).toEqual({ phase: 'failed', reason: 'timeout' });
    expect(sent(bus, 'data')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a joiner with no host gives up with no_answer', async () => {
    const bus = createBus();
    const j = join(bus, device([]));
    await j.reached('waiting');
    await vi.advanceTimersByTimeAsync(HELLO_WAIT_MS);
    expect(j.last()).toEqual({ phase: 'failed', reason: 'no_answer' });
    expect(bus.openMembers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a joiner that was answered but never sent the data times out', async () => {
    const bus = createBus();
    const { j } = await joinerAtReceiving(bus, device([]));
    // The hello timer is replaced, not left running: no_answer would come at 20 s.
    await vi.advanceTimersByTimeAsync(HELLO_WAIT_MS);
    expect(j.last().phase).toBe('receiving');
    await vi.advanceTimersByTimeAsync(AFTER_REPLY_MS - HELLO_WAIT_MS);
    expect(j.last()).toEqual({ phase: 'failed', reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a joiner still checking the reply when the data arrives opens it once the key is ready', async () => {
    const bus = createBus();
    const b = device([]);
    const p = await handHost(bus);
    const j = join(bus, b);
    await j.reached('waiting');
    const { reply, key } = await p.replyTo();
    const data = await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)]));
    await p.t.publish('reply', reply);
    await p.t.publish('data', data);
    await j.reached('done');
    expect(j.states.map((s) => s.phase)).toEqual(['connecting', 'waiting', 'receiving', 'done']);
    expect(codes(b)).toEqual(['AAAA2222']);
  });

  describe('data that arrives while the joiner is still checking the reply', () => {
    /** A joiner at waiting, with a hand-played host's reply and session key ready but not yet sent. */
    async function joinerBeforeReply(b: ReturnType<typeof device>) {
      const bus = createBus();
      const p = await handHost(bus);
      const s = spy(bus.open);
      const j = join(bus, b, CODE, s.open);
      await j.reached('waiting');
      const { reply, key } = await p.replyTo();
      const data = (storms: RecentStorm[]) => seal(key, p.keys.channelId, 'data', buildPayload(storms));
      return { bus, p, s, j, reply, key, data };
    }

    it('is dropped with the session when the reply turns out to be forged', async () => {
      const b = device([storm('BBBB4444', 3000)]);
      const merge = vi.fn(b.merge);
      b.merge = merge;
      const { bus, s, j, reply, data } = await joinerBeforeReply(b);
      const wrong = await deriveFromCode(OTHER_CODE);
      const joinerPub = parsePublicKey((sent(bus, 'hello')[0].data as { pub: string }).pub)!;
      const pubS = parsePublicKey(reply.pub)!;
      const forged = { pub: reply.pub, tag: await makeTag(wrong.authKey, 'S', pubS, joinerPub) };
      const payload = await data([storm('AAAA2222', 2000)]);
      s.handlers[0]('reply', forged);
      s.handlers[0]('data', payload);
      await j.reached('failed');
      await settle();
      expect(j.last()).toEqual({ phase: 'failed', reason: 'wrong_code' });
      expect(merge).not.toHaveBeenCalled();
      expect(codes(b)).toEqual(['BBBB4444']);
      expect(sent(bus, 'done')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('fails as invalid when it was tampered with, leaving the list alone', async () => {
      const b = device([storm('BBBB4444', 3000)]);
      const { bus, s, j, reply, data } = await joinerBeforeReply(b);
      const payload = corrupt(await data([storm('AAAA2222', 2000)]));
      s.handlers[0]('reply', reply);
      s.handlers[0]('data', payload);
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'invalid' });
      expect(codes(b)).toEqual(['BBBB4444']);
      expect(sent(bus, 'done')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('only the first is held: a second one in the same window is ignored', async () => {
      const b = device([]);
      const merge = vi.fn(b.merge);
      b.merge = merge;
      const { s, j, reply, data } = await joinerBeforeReply(b);
      const first = await data([storm('AAAA2222', 2000)]);
      const second = await data([storm('CCCC6666', 2000)]);
      s.handlers[0]('reply', reply);
      s.handlers[0]('data', first);
      s.handlers[0]('data', second);
      await j.reached('done');
      await settle();
      expect(merge).toHaveBeenCalledTimes(1);
      expect(codes(b)).toEqual(['AAAA2222']);
      expect(j.states.filter((x) => x.phase === 'done')).toHaveLength(1);
    });

    it('is never opened when the joiner is cancelled while checking the reply', async () => {
      const b = device([storm('BBBB4444', 3000)]);
      const merge = vi.fn(b.merge);
      b.merge = merge;
      const { bus, s, j, reply, data } = await joinerBeforeReply(b);
      const payload = await data([storm('AAAA2222', 2000)]);
      s.handlers[0]('reply', reply);
      s.handlers[0]('data', payload);
      j.j.cancel();
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting']);
      expect(merge).not.toHaveBeenCalled();
      expect(codes(b)).toEqual(['BBBB4444']);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'done')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a joiner that has merged reports done, even when its done is slow to send and the 30 s pass meanwhile', async () => {
    const bus = createBus();
    const b = device([storm('BBBB4444', 3000)]);
    let doneSending = false;
    const slow: OpenTransport = (channelId) => {
      const t = bus.open(channelId);
      return {
        ...t,
        publish: async (name, data) => {
          if (name === 'done') {
            doneSending = true;
            await new Promise((r) => setTimeout(r, 1000));
          }
          return t.publish(name, data);
        },
      };
    };
    const { j, p, key } = await joinerAtReceiving(bus, b, slow);
    const data = await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)]));
    await vi.advanceTimersByTimeAsync(AFTER_REPLY_MS - 100);
    await p.t.publish('data', data);
    await until(() => doneSending);
    await vi.advanceTimersByTimeAsync(1000);
    await j.reached('done');
    expect(j.states.map((s) => s.phase)).toEqual(['connecting', 'waiting', 'receiving', 'done']);
    expect(codes(b)).toEqual(['AAAA2222', 'BBBB4444']);
    expect(sent(bus, 'done')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('cancel', () => {
    it('host at connecting: never opens a transport', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      const h = host(bus, device([]), CODE, s.open);
      h.h.cancel();
      await settle();
      expect(h.states).toEqual([{ phase: 'connecting' }]);
      expect(s.opened()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host at waiting: closes, and a late hello is ignored', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      const h = host(bus, device([]), CODE, s.open);
      await h.reached('waiting');
      h.h.cancel();
      expect(s.allClosed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const p = await handJoiner(bus);
      s.handlers[0]('hello', p.hello);
      await settle();
      expect(h.states.map((x) => x.phase)).toEqual(['connecting', 'waiting']);
      expect(s.lateSends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host while checking a hello: sends no reply and emits nothing', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      const h = host(bus, device([]), CODE, s.open);
      await h.reached('waiting');
      const p = await handJoiner(bus);
      s.handlers[0]('hello', p.hello);
      h.h.cancel();
      await settle();
      expect(h.states.map((x) => x.phase)).toEqual(['connecting', 'waiting']);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'reply')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host at ready: closes, confirm does nothing, and a late done is ignored', async () => {
      const bus = createBus();
      const a = device([storm('AAAA2222', 2000)]);
      const s = spy(bus.open);
      const h = host(bus, a, CODE, s.open);
      await h.reached('waiting');
      const p = await handJoiner(bus);
      await p.sayHello();
      const key = await p.keyFromReply();
      await h.reached('ready');
      h.h.cancel();
      expect(s.allClosed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await h.h.confirm();
      s.handlers[0]('done', await seal(key, p.keys.channelId, 'done', buildDone({ added: 0, updated: 0, kept: 0 }, [storm('LATE2222', 4000)])));
      await settle();
      expect(h.states.map((x) => x.phase)).toEqual(['connecting', 'waiting', 'ready']);
      expect(codes(a)).toEqual(['AAAA2222']);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'data')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host at sending: sends nothing after the cancel', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      const h = host(bus, device([storm('AAAA2222', 2000)]), CODE, s.open);
      await h.reached('waiting');
      const p = await handJoiner(bus);
      await p.sayHello();
      await h.reached('ready');
      const confirming = h.h.confirm();
      expect(h.last().phase).toBe('sending');
      h.h.cancel();
      await confirming;
      await settle();
      expect(h.states.map((x) => x.phase)).toEqual(['connecting', 'waiting', 'ready', 'sending']);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'data')).toHaveLength(0);
      expect(s.allClosed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host while checking a done: merges nothing', async () => {
      const bus = createBus();
      const a = device([storm('AAAA2222', 2000)]);
      const s = spy(bus.open);
      const { h, p, key } = await hostAtSending(bus, a, s.open);
      const done = await seal(key, p.keys.channelId, 'done', buildDone({ added: 0, updated: 0, kept: 1 }, [storm('BBBB4444', 3000), storm('AAAA2222', 2000)]));
      s.handlers[0]('done', done);
      h.h.cancel();
      await settle();
      expect(h.last().phase).toBe('sending');
      expect(codes(a)).toEqual(['AAAA2222']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner at connecting: never opens a transport', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      const j = join(bus, device([]), CODE, s.open);
      j.j.cancel();
      await settle();
      expect(j.states).toEqual([{ phase: 'connecting' }]);
      expect(s.opened()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    /** Cancels `j` the moment the first call to `method` starts, then lets the call finish as usual. */
    function cancelDuring(method: 'generateKey' | 'sign' | 'encrypt', target: () => { cancel(): void }) {
      const original = crypto.subtle[method].bind(crypto.subtle) as (...args: unknown[]) => Promise<unknown>;
      return vi.spyOn(crypto.subtle, method).mockImplementationOnce(((...args: unknown[]) => {
        target().cancel();
        return original(...args);
      }) as never);
    }

    it('joiner cancelled while making its key pair: never opens a transport', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      let j: ReturnType<typeof join> | undefined;
      const during = cancelDuring('generateKey', () => j!.j);
      j = join(bus, device([]), CODE, s.open);
      await until(() => during.mock.calls.length === 1);
      await settle();
      expect(j.states).toEqual([{ phase: 'connecting' }]);
      expect(s.opened()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner cancelled while tagging its hello: never opens a transport or says hello', async () => {
      const bus = createBus();
      const s = spy(bus.open);
      let j: ReturnType<typeof join> | undefined;
      const during = cancelDuring('sign', () => j!.j);
      j = join(bus, device([]), CODE, s.open);
      await until(() => during.mock.calls.length === 1);
      await settle();
      expect(j.states).toEqual([{ phase: 'connecting' }]);
      expect(s.opened()).toBe(0);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'hello')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner at waiting: closes, and a late reply is ignored', async () => {
      const bus = createBus();
      const p = await handHost(bus);
      const s = spy(bus.open);
      const j = join(bus, device([]), CODE, s.open);
      await j.reached('waiting');
      const { reply } = await p.replyTo();
      j.j.cancel();
      expect(s.allClosed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      s.handlers[0]('reply', reply);
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting']);
      expect(s.lateSends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner while checking a reply: emits nothing and arms no timer', async () => {
      const bus = createBus();
      const p = await handHost(bus);
      const s = spy(bus.open);
      const j = join(bus, device([]), CODE, s.open);
      await j.reached('waiting');
      const { reply } = await p.replyTo();
      s.handlers[0]('reply', reply);
      j.j.cancel();
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner at receiving: closes, and late data is ignored', async () => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const s = spy(bus.open);
      const { j, p, key } = await joinerAtReceiving(bus, b, s.open);
      j.j.cancel();
      expect(s.allClosed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      s.handlers[0]('data', await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)])));
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting', 'receiving']);
      expect(codes(b)).toEqual(['BBBB4444']);
      expect(s.lateSends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner while opening the data: merges nothing and sends nothing', async () => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const s = spy(bus.open);
      const { j, p, key } = await joinerAtReceiving(bus, b, s.open);
      const data = await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)]));
      s.handlers[0]('data', data);
      j.j.cancel();
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting', 'receiving']);
      expect(codes(b)).toEqual(['BBBB4444']);
      expect(s.lateSends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner while sealing its done: sends nothing and emits nothing', async () => {
      const bus = createBus();
      const b = device([storm('BBBB4444', 3000)]);
      const s = spy(bus.open);
      const { j, p, key } = await joinerAtReceiving(bus, b, s.open);
      const data = await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)]));
      const during = cancelDuring('encrypt', () => j.j);
      await p.t.publish('data', data);
      await until(() => during.mock.calls.length === 1);
      await settle();
      expect(j.states.map((x) => x.phase)).toEqual(['connecting', 'waiting', 'receiving']);
      expect(s.lateSends).toEqual([]);
      expect(sent(bus, 'done')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('transport failure', () => {
    /** A transport where subscribing, or sending one kind of message, fails. */
    function broken(bus: Bus, what: 'subscribe' | 'hello' | 'reply' | 'data') {
      let closes = 0;
      const open: OpenTransport = (channelId) => {
        const t = bus.open(channelId);
        return {
          publish: (name, data) => (name === what ? Promise.reject(new Error('down')) : t.publish(name, data)),
          subscribe: what === 'subscribe' ? () => Promise.reject(new Error('down')) : t.subscribe,
          close: () => {
            closes++;
            t.close();
          },
        };
      };
      return { open, closes: () => closes };
    }

    it('host: a subscribe that fails ends with connection, closed', async () => {
      const bus = createBus();
      const t = broken(bus, 'subscribe');
      const h = host(bus, device([]), CODE, t.open);
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'connection' });
      expect(t.closes()).toBe(1);
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner: a subscribe that fails ends with connection, closed', async () => {
      const bus = createBus();
      const t = broken(bus, 'subscribe');
      const j = join(bus, device([]), CODE, t.open);
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'connection' });
      expect(t.closes()).toBe(1);
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    /** A transport whose server refused this device's license. */
    function unlicensed(bus: Bus) {
      const open: OpenTransport = (channelId) => ({ ...bus.open(channelId), subscribe: () => Promise.reject(new PairLicenseError()) });
      return open;
    }

    it('host: a refused license ends with license, not connection, closed and with no timer', async () => {
      const bus = createBus();
      const h = host(bus, device([]), CODE, unlicensed(bus));
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'license' });
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner: a refused license ends with license, not connection, and says no hello', async () => {
      const bus = createBus();
      const j = join(bus, device([]), CODE, unlicensed(bus));
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'license' });
      expect(sent(bus, 'hello')).toHaveLength(0);
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    /** A transport whose server has handed out as many tokens as it allows for now. */
    function limited(bus: Bus, retryAfterSeconds?: number) {
      const open: OpenTransport = (channelId) => ({ ...bus.open(channelId), subscribe: () => Promise.reject(new PairRateLimitError(retryAfterSeconds)) });
      return open;
    }

    it.each([[720], [undefined]])('host: too many attempts ends with rate_limited, carrying the wait (%s)', async (wait) => {
      const bus = createBus();
      const h = host(bus, device([]), CODE, limited(bus, wait));
      await h.reached('failed');
      expect(h.last()).toEqual(wait === undefined ? { phase: 'failed', reason: 'rate_limited' } : { phase: 'failed', reason: 'rate_limited', retryAfterSeconds: wait });
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner: too many attempts ends with rate_limited, carrying the wait, and says no hello', async () => {
      const bus = createBus();
      const j = join(bus, device([]), CODE, limited(bus, 90));
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'rate_limited', retryAfterSeconds: 90 });
      expect(sent(bus, 'hello')).toHaveLength(0);
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host: a reply that cannot be sent ends with connection, closed', async () => {
      const bus = createBus();
      const t = broken(bus, 'reply');
      const h = host(bus, device([]), CODE, t.open);
      await h.reached('waiting');
      const p = await handJoiner(bus);
      await p.sayHello();
      await h.reached('failed');
      expect(h.last()).toEqual({ phase: 'failed', reason: 'connection' });
      expect(t.closes()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('host: data that cannot be sent ends with connection, closed', async () => {
      const bus = createBus();
      const t = broken(bus, 'data');
      const h = host(bus, device([storm('AAAA2222', 2000)]), CODE, t.open);
      await h.reached('waiting');
      const p = await handJoiner(bus);
      await p.sayHello();
      await h.reached('ready');
      await h.h.confirm();
      expect(h.last()).toEqual({ phase: 'failed', reason: 'connection' });
      expect(t.closes()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner: a hello that cannot be sent ends with connection, closed', async () => {
      const bus = createBus();
      const t = broken(bus, 'hello');
      const j = join(bus, device([]), CODE, t.open);
      await j.reached('failed');
      expect(j.last()).toEqual({ phase: 'failed', reason: 'connection' });
      expect(t.closes()).toBe(1);
      expect(bus.openMembers()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('joiner: a hello reported failed after the reply already came does not end a working session', async () => {
      const bus = createBus();
      const b = device([]);
      const lateFailure: OpenTransport = (channelId) => {
        const t = bus.open(channelId);
        return {
          ...t,
          publish: async (name, data) => {
            await t.publish(name, data);
            if (name === 'hello') await new Promise((_, reject) => setTimeout(() => reject(new Error('no ack')), 1000));
          },
        };
      };
      const { j, p, key } = await joinerAtReceiving(bus, b, lateFailure);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(j.last().phase).toBe('receiving');
      await p.t.publish('data', await seal(key, p.keys.channelId, 'data', buildPayload([storm('AAAA2222', 2000)])));
      await j.reached('done');
      expect(codes(b)).toEqual(['AAAA2222']);
    });
  });

  it('a newer entry on the joiner is never overwritten, and the host takes it', async () => {
    const bus = createBus();
    const newer = { ...storm('SAME3333', 5000), secret: 'NEWER'.padEnd(128, 'y') };
    const a = device([storm('SAME3333', 1000)]);
    const b = device([newer]);
    const h = host(bus, a);
    await h.reached('waiting');
    const j = join(bus, b);
    await h.reached('ready');
    await h.h.confirm();
    await h.reached('done');
    await j.reached('done');
    expect(j.last()).toEqual({ phase: 'done', result: { added: 0, updated: 0, kept: 1 } });
    expect(h.last()).toEqual({ phase: 'done', result: { added: 0, updated: 1, kept: 0 } });
    expect(b.list()).toEqual([newer]);
    expect(a.list()).toEqual([newer]);
  });
});
