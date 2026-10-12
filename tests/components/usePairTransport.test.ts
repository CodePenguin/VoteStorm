// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    retryAfter?: number;
    constructor(message: string, status: number, retryAfter?: number) {
      super(message);
      this.status = status;
      this.retryAfter = retryAfter;
    }
  },
}));
const apiMock = vi.fn();
vi.mock('@/api', () => ({ api: (...a: unknown[]) => apiMock(...a), ApiError: FakeApiError }));

const channel = { publish: vi.fn(async () => {}), subscribe: vi.fn(async () => null) };
const close = vi.fn();
let ctorOptions: any;
vi.mock('ably', () => ({
  Realtime: class {
    channels = { get: vi.fn(() => channel) };
    close = close;
    constructor(options: unknown) { ctorOptions = options; }
  },
}));

import { CONNECT_TIMEOUT_MS, openPairTransport } from '@/composables/usePairTransport';
import { PairLicenseError, PairRateLimitError } from '@/lib/pairing';

const ID = 'ab12'.repeat(16);
const realSetImmediate = globalThis.setImmediate;

describe('openPairTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    channel.publish.mockClear();
    channel.subscribe.mockReset();
    channel.subscribe.mockResolvedValue(null);
    close.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('does not hear its own messages and fetches its token for this channel only', async () => {
    openPairTransport(ID);
    expect(ctorOptions.echoMessages).toBe(false);
    apiMock.mockResolvedValue({ keyName: 'k' });
    const cb = vi.fn();
    await ctorOptions.authCallback({}, cb);
    expect(apiMock).toHaveBeenCalledWith(`pair-token?id=${ID}`);
    expect(cb).toHaveBeenCalledWith(null, { keyName: 'k' });
  });

  it('passes a token failure to Ably', async () => {
    openPairTransport(ID);
    const err = new Error('429');
    apiMock.mockRejectedValue(err);
    const cb = vi.fn();
    await ctorOptions.authCallback({}, cb);
    expect(cb).toHaveBeenCalledWith(err, null);
  });

  it('publishes named messages and hands received ones to the handler', async () => {
    const t = openPairTransport(ID);
    const handler = vi.fn();
    await t.subscribe(handler);
    const listener = channel.subscribe.mock.calls[0][0];
    listener({ name: 'reply', data: { pub: 'x' } });
    expect(handler).toHaveBeenCalledWith('reply', { pub: 'x' });
    await t.publish('hello', { a: 1 });
    expect(channel.publish).toHaveBeenCalledWith('hello', { a: 1 });
  });

  it('gives up when the channel never attaches, instead of hanging', async () => {
    channel.subscribe.mockReturnValue(new Promise(() => {}));
    const t = openPairTransport(ID);
    const attached = t.subscribe(vi.fn());
    const outcome = expect(attached).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await outcome;
  });

  it('clears its connect timer once attached', async () => {
    const t = openPairTransport(ID);
    await t.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails at once, timer cleared, when attaching is refused', async () => {
    channel.subscribe.mockRejectedValue(new Error('refused'));
    const t = openPairTransport(ID);
    await expect(t.subscribe(vi.fn())).rejects.toThrow('refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no unhandled rejection when the attach fails after the timeout', async () => {
    let refuse!: (e: Error) => void;
    channel.subscribe.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const t = openPairTransport(ID);
      const attached = t.subscribe(vi.fn());
      const outcome = expect(attached).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      await outcome;
      refuse(new Error('late'));
      await new Promise((r) => realSetImmediate(r));
      await new Promise((r) => realSetImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each([403, 401])('ends a pending subscribe at once as a license failure when the token is refused with %i', async (status) => {
    channel.subscribe.mockReturnValue(new Promise(() => {}));
    const t = openPairTransport(ID);
    const attached = t.subscribe(vi.fn());
    const outcome = expect(attached).rejects.toBeInstanceOf(PairLicenseError);
    apiMock.mockRejectedValue(new FakeApiError('Syncing needs a license.', status));
    const cb = vi.fn();
    await ctorOptions.authCallback({}, cb);
    await outcome;
    expect(cb).toHaveBeenCalledWith(expect.any(FakeApiError), null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a license failure when the token was refused before subscribing', async () => {
    const t = openPairTransport(ID);
    apiMock.mockRejectedValue(new FakeApiError('Syncing needs a license.', 403));
    await ctorOptions.authCallback({}, vi.fn());
    channel.subscribe.mockReturnValue(new Promise(() => {}));
    await expect(t.subscribe(vi.fn())).rejects.toBeInstanceOf(PairLicenseError);
  });

  it('reports a license failure even when Ably fails the attach in its own words', async () => {
    let refuse!: (e: Error) => void;
    channel.subscribe.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const t = openPairTransport(ID);
    const attached = t.subscribe(vi.fn());
    apiMock.mockRejectedValue(new FakeApiError('Invalid license', 401));
    // Ably fails the attach before the refusal reaches the transport's own hook (the order is Ably's to choose).
    const pending = ctorOptions.authCallback({}, () => refuse(new Error('Ably auth failed')));
    await expect(attached).rejects.toBeInstanceOf(PairLicenseError);
    await pending;
  });

  it('treats any other token failure as a connection problem, not a refusal', async () => {
    channel.subscribe.mockReturnValue(new Promise(() => {}));
    const t = openPairTransport(ID);
    const attached = t.subscribe(vi.fn());
    const outcome = attached.then(() => null, (e) => e);
    apiMock.mockRejectedValue(new FakeApiError('Server error', 500));
    await ctorOptions.authCallback({}, vi.fn());
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PairLicenseError);
    expect(err).not.toBeInstanceOf(PairRateLimitError);
  });

  it.each([[720, 720], [undefined, undefined]])('ends a pending subscribe at once on a 429 (Retry-After %s), carrying the wait', async (header, expected) => {
    channel.subscribe.mockReturnValue(new Promise(() => {}));
    const t = openPairTransport(ID);
    const attached = t.subscribe(vi.fn());
    const outcome = attached.then(() => null, (e) => e);
    apiMock.mockRejectedValue(new FakeApiError('Too many requests', 429, header));
    await ctorOptions.authCallback({}, vi.fn());
    const err = await outcome;
    expect(err).toBeInstanceOf(PairRateLimitError);
    expect((err as PairRateLimitError).retryAfterSeconds).toBe(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers Ably\'s later token requests with the refusal, without asking the server again', async () => {
    openPairTransport(ID);
    apiMock.mockRejectedValue(new FakeApiError('Too many requests', 429, 60));
    await ctorOptions.authCallback({}, vi.fn());
    expect(apiMock).toHaveBeenCalledTimes(1);
    const retry = vi.fn();
    await ctorOptions.authCallback({}, retry);
    await ctorOptions.authCallback({}, vi.fn());
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(expect.any(PairRateLimitError), null);
  });

  it('closes the connection', () => {
    openPairTransport(ID).close();
    expect(close).toHaveBeenCalled();
  });
});
