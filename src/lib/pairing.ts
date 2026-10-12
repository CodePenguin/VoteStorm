import { toBase64Url } from '@/lib/adminKeys';
import {
  MAX_MESSAGE_BYTES, buildPayload, checkTag, deriveFromCode, makeEphemeral, makeTag, parsePayload, parsePublicKey, parseDone, buildDone, seal,
  sessionKey, unseal, type CodeKeys, type Ephemeral,
} from '@/lib/pairCrypto';
import { MAX_RECENT, type MergeResult, type RecentStorm } from '@/lib/recentStorms';

// Syncing the Storms list between two of the same person's devices. See docs/superpowers/specs/2026-10-11-device-pairing-design.md.
// One device hosts (it shows the code), the other joins (it types it); which is which makes no difference. Both derive a private channel and a MAC key from it; each side proves it knows
// the code, they agree an encryption key with ECDH, and the host's list travels sealed to the joiner, which merges it and sends its merged list back sealed the same way. Everything here is written
// against a small transport so it can be tested without a network; the real one is usePairTransport.ts.

export const CODE_TTL_MS = 120_000;
export const HELLO_WAIT_MS = 20_000;
export const AFTER_REPLY_MS = 30_000;
/** How long the joiner waits for its done to go out once it has merged; past it the joiner reports done anyway. */
export const DONE_SEND_MS = 5_000;

export interface PairTransport {
  publish(name: 'hello' | 'reply' | 'data' | 'done', data: unknown): Promise<void>;
  /** Resolves once the channel is attached, so nothing sent after it is missed. Rejects when it cannot connect. */
  subscribe(handler: (name: string, data: unknown) => void): Promise<void>;
  close(): void;
}
export type OpenTransport = (channelId: string) => PairTransport;

export type PairFailure = 'wrong_code' | 'no_answer' | 'expired' | 'timeout' | 'invalid' | 'connection' | 'license' | 'rate_limited';
/** Every failure but the one that carries a wait. */
type PlainFailure = Exclude<PairFailure, 'rate_limited'>;

/** A failed session: why, and for too many attempts, how many seconds until the server allows another (when it said). */
export type FailedState =
  | { phase: 'failed'; reason: PlainFailure }
  | { phase: 'failed'; reason: 'rate_limited'; retryAfterSeconds?: number };

/** What a transport throws when this device may not sync: the server refused its license (none, or not a valid one). */
export class PairLicenseError extends Error {
  constructor() {
    super('Syncing needs a license');
    this.name = 'PairLicenseError';
  }
}

/** What a transport throws when the server has handed out as many pairing tokens as it allows for now. */
export class PairRateLimitError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super('Too many sync attempts');
    this.name = 'PairRateLimitError';
  }
}

/** How a failure to get going is reported: a refusal from the server says why; anything else is a connection problem. */
function startFailure(err: unknown): FailedState {
  if (err instanceof PairRateLimitError) {
    return err.retryAfterSeconds === undefined
      ? { phase: 'failed', reason: 'rate_limited' }
      : { phase: 'failed', reason: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds };
  }
  return { phase: 'failed', reason: err instanceof PairLicenseError ? 'license' : 'connection' };
}

export type HostState =
  | { phase: 'connecting' }
  | { phase: 'waiting'; expiresAt: number }
  | { phase: 'ready'; count: number; expiresAt: number }
  | { phase: 'sending' }
  | { phase: 'done'; result: MergeResult }
  | FailedState;

export type JoinState =
  | { phase: 'connecting' }
  | { phase: 'waiting' }
  | { phase: 'receiving' }
  | { phase: 'done'; result: MergeResult }
  | FailedState;

/** What both roles share: a transport and one timer that are always released together, once, however the session ends. */
function makeSession(onEnd: (reason: PlainFailure) => void) {
  let transport: PairTransport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const stop = () => {
    ended = true;
    clearTimeout(timer);
    transport?.close();
  };
  return {
    get ended() { return ended; },
    setTransport(t: PairTransport) { transport = t; },
    get transport() { return transport!; },
    arm(ms: number, reason: PlainFailure) {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!ended) { stop(); onEnd(reason); } }, ms);
    },
    /** Stops the timer without ending the session: past this point it can only end by `finish` or `cancel`. */
    disarm() { clearTimeout(timer); },
    /**
     * Resolves when `p` settles, either way, or when `ms` pass, whichever is first. It uses the session's one timer, so a cancel
     * releases it too (and then this never resolves, which is fine: nothing after it may run once the session has ended).
     */
    settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        clearTimeout(timer);
        timer = setTimeout(() => resolve(), ms);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        p.then(done, done);
      });
    },
    /** Ends the session; `emit` runs only the first time. */
    finish(emit: () => void) {
      if (ended) return;
      stop();
      emit();
    },
    cancel: stop,
  };
}

export function startHost(opts: { code: string; storms: RecentStorm[]; open: OpenTransport; merge: (incoming: RecentStorm[]) => MergeResult; onState: (s: HostState) => void; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const storms = opts.storms.slice(0, MAX_RECENT);
  const session = makeSession((reason) => opts.onState({ phase: 'failed', reason }));
  const failWith = (state: FailedState) => session.finish(() => opts.onState(state));
  const fail = (reason: PlainFailure) => failWith({ phase: 'failed', reason });
  let phase: 'connecting' | 'waiting' | 'verifying' | 'ready' | 'sending' | 'merging' = 'connecting';
  let keys: CodeKeys;
  let mine: Ephemeral;
  let key: CryptoKey;

  opts.onState({ phase: 'connecting' });

  function onMessage(name: string, data: unknown) {
    if (session.ended) return;
    // The phase is set before the first await, so a second hello that arrives while this one is checked is ignored.
    if (phase === 'waiting' && name === 'hello') void onHello(data);
    else if (phase === 'sending' && name === 'done') void onDone(data);
  }

  async function onHello(data: unknown) {
    phase = 'verifying';
    const m = data as { pub?: unknown; tag?: unknown } | null;
    const pubR = parsePublicKey(m?.pub);
    if (!pubR) return fail('invalid');
    let tag: string;
    try {
      if (!(await checkTag(keys.authKey, m?.tag, 'R', pubR))) return fail('wrong_code');
    } catch {
      return fail('invalid');
    }
    try {
      mine = await makeEphemeral();
      tag = await makeTag(keys.authKey, 'S', mine.pub, pubR);
    } catch {
      // This device's own crypto failed, nothing the other device sent: reported as the joiner reports its own failure to start.
      return fail('connection');
    }
    try {
      key = await sessionKey(mine, pubR, pubR, mine.pub);
    } catch {
      // A correctly tagged key that is not a usable point: the same answer the joiner gives for a bad reply.
      return fail('invalid');
    }
    if (session.ended) return;
    try {
      await session.transport.publish('reply', { pub: toBase64Url(mine.pub), tag });
      if (session.ended) return;
      phase = 'ready';
      session.arm(AFTER_REPLY_MS, 'timeout');
      opts.onState({ phase: 'ready', count: storms.length, expiresAt: now() + AFTER_REPLY_MS });
    } catch {
      fail('connection');
    }
  }

  async function onDone(data: unknown) {
    // Like hello: only the first done is looked at, so a replayed one cannot be merged twice.
    phase = 'merging';
    try {
      if (JSON.stringify(data).length > MAX_MESSAGE_BYTES) return fail('invalid');
      const back = parseDone(await unseal(key, keys.channelId, 'done', data));
      if (session.ended) return;
      if (!back) return fail('invalid');
      // The joiner has already merged the host's list, so this brings the host up to the same list. The result shown is the host's own.
      const result = opts.merge(back.storms);
      session.finish(() => opts.onState({ phase: 'done', result }));
    } catch {
      fail('invalid');
    }
  }

  void (async () => {
    try {
      keys = await deriveFromCode(opts.code);
      if (session.ended) return;
      session.setTransport(opts.open(keys.channelId));
      await session.transport.subscribe(onMessage);
      if (session.ended) return;
      phase = 'waiting';
      session.arm(CODE_TTL_MS, 'expired');
      opts.onState({ phase: 'waiting', expiresAt: now() + CODE_TTL_MS });
    } catch (err) {
      failWith(startFailure(err));
    }
  })();

  return {
    async confirm() {
      if (phase !== 'ready' || session.ended) return;
      phase = 'sending';
      opts.onState({ phase: 'sending' });
      try {
        const sealed = await seal(key, keys.channelId, 'data', buildPayload(storms));
        if (session.ended) return;
        if (JSON.stringify(sealed).length > MAX_MESSAGE_BYTES) return fail('invalid');
        await session.transport.publish('data', sealed);
        if (!session.ended) session.arm(AFTER_REPLY_MS, 'timeout');
      } catch {
        fail('connection');
      }
    },
    cancel: session.cancel,
  };
}

export function startJoin(opts: { code: string; open: OpenTransport; merge: (incoming: RecentStorm[]) => MergeResult; list: () => RecentStorm[]; onState: (s: JoinState) => void }) {
  const session = makeSession((reason) => opts.onState({ phase: 'failed', reason }));
  const failWith = (state: FailedState) => session.finish(() => opts.onState(state));
  const fail = (reason: PlainFailure) => failWith({ phase: 'failed', reason });
  let phase: 'connecting' | 'waiting' | 'verifying' | 'receiving' | 'merging' = 'connecting';
  let keys: CodeKeys;
  let mine: Ephemeral;
  let key: CryptoKey;

  opts.onState({ phase: 'connecting' });

  // Data that arrives while the reply is still being checked (the host confirmed at once): held, and opened once the key is ready.
  let early: { data: unknown } | null = null;

  function onMessage(name: string, data: unknown) {
    if (session.ended) return;
    if (phase === 'waiting' && name === 'reply') void onReply(data);
    else if (phase === 'verifying' && name === 'data' && !early) early = { data };
    else if (phase === 'receiving' && name === 'data') void onData(data);
  }

  async function onReply(data: unknown) {
    phase = 'verifying';
    const m = data as { pub?: unknown; tag?: unknown } | null;
    const pubS = parsePublicKey(m?.pub);
    if (!pubS) return fail('invalid');
    try {
      if (!(await checkTag(keys.authKey, m?.tag, 'S', pubS, mine.pub))) return fail('wrong_code');
      key = await sessionKey(mine, pubS, mine.pub, pubS);
      if (session.ended) return;
      phase = 'receiving';
      session.arm(AFTER_REPLY_MS, 'timeout');
      opts.onState({ phase: 'receiving' });
      if (early) void onData(early.data);
    } catch {
      fail('invalid');
    }
  }

  async function onData(data: unknown) {
    phase = 'merging';
    try {
      if (JSON.stringify(data).length > MAX_MESSAGE_BYTES) return fail('invalid');
      const storms = parsePayload(await unseal(key, keys.channelId, 'data', data));
      if (session.ended) return;
      if (!storms) return fail('invalid');
      const result = opts.merge(storms);
      // This device's list has changed, so from here the session can only end as done (or be cancelled), never time out.
      session.disarm();
      try {
        const sealed = await seal(key, keys.channelId, 'done', buildDone(result, opts.list()));
        if (session.ended) return;
        // Like the host's data: a message over the limit is never sent.
        // Bounded: a send that never settles must not hold this device, whose list is already merged, short of done.
        if (JSON.stringify(sealed).length <= MAX_MESSAGE_BYTES) await session.settleWithin(session.transport.publish('done', sealed), DONE_SEND_MS);
      } catch {
        /* this device is up to date; the host just will not get this device's list */
      }
      session.finish(() => opts.onState({ phase: 'done', result }));
    } catch {
      fail('invalid');
    }
  }

  void (async () => {
    try {
      keys = await deriveFromCode(opts.code);
      if (session.ended) return;
      mine = await makeEphemeral();
      // The hello is complete before the channel is opened, so nothing is awaited between `waiting` and sending it.
      const hello = { pub: toBase64Url(mine.pub), tag: await makeTag(keys.authKey, 'R', mine.pub) };
      if (session.ended) return;
      session.setTransport(opts.open(keys.channelId));
      await session.transport.subscribe(onMessage);
      if (session.ended) return;
      phase = 'waiting';
      session.arm(HELLO_WAIT_MS, 'no_answer');
      opts.onState({ phase: 'waiting' });
      try {
        await session.transport.publish('hello', hello);
      } catch {
        // A reply can only come if the hello went out, but should one have been handled already, the session is working.
        if (phase === 'waiting') fail('connection');
      }
    } catch (err) {
      failWith(startFailure(err));
    }
  })();

  return { cancel: session.cancel };
}
