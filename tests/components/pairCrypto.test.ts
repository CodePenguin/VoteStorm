// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { toBase64Url } from '@/lib/adminKeys';
import {
  CODE_LENGTH, MAX_MESSAGE_BYTES, buildPayload, checkTag, deriveFromCode, formatCode, generateCode, makeEphemeral, makeTag,
  normalizeCode, parsePayload, parsePublicKey, parseDone, buildDone, seal, sessionKey, unseal,
} from '@/lib/pairCrypto';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const entry = (over: Record<string, unknown> = {}) => ({ stormCode: 'ABCD2345', secret: 'S'.repeat(128), name: 'Town hall', lastOpenedAt: 1000, ...over });

describe('codes', () => {
  it('draws 10 characters from the unambiguous alphabet, and a different one each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => ALPHABET.includes(c))).toBe(true);
      seen.add(code);
    }
    expect(seen.size).toBe(50);
  });

  it('formats as two groups of five', () => expect(formatCode('ABCDE12345')).toBe('ABCDE-12345'));

  it('normalizes case, spaces, hyphens and look-alike letters', () => {
    expect(normalizeCode('abcde-12345')).toBe('ABCDE12345');
    expect(normalizeCode(' abcde 12345 ')).toBe('ABCDE12345');
    expect(normalizeCode('ABCDE-1234O')).toBe('ABCDE12340'); // O is a zero
    expect(normalizeCode('ABCDE-l234I')).toBe('ABCDE12341'); // l and I are ones
  });

  it('refuses anything that cannot be a code', () => {
    for (const bad of ['', 'ABCDE', 'ABCDE-1234', 'ABCDE-123456', 'ABCDE-1234U', 'ABCDE-1234!', '😀😀😀😀😀😀😀😀😀😀']) expect(normalizeCode(bad), bad).toBeNull();
  });
});

describe('keys derived from the code', () => {
  it('gives the same channel for the same code and a different one for another code', async () => {
    const a = await deriveFromCode('ABCDE12345');
    const b = await deriveFromCode('ABCDE12345');
    const c = await deriveFromCode('ABCDE12346');
    expect(a.channelId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.channelId).toBe(b.channelId);
    expect(a.channelId).not.toBe(c.channelId);
    expect(a.channelId).not.toContain('ABCDE');
  });

  it('makes tags only the same code can verify, bound to the label and the keys', async () => {
    const right = await deriveFromCode('ABCDE12345');
    const wrong = await deriveFromCode('ABCDE12346');
    const pubR = new Uint8Array(65).fill(4);
    const pubS = new Uint8Array(65).fill(5);
    const tag = await makeTag(right.authKey, 'S', pubS, pubR);
    expect(await checkTag(right.authKey, tag, 'S', pubS, pubR)).toBe(true);
    expect(await checkTag(wrong.authKey, tag, 'S', pubS, pubR)).toBe(false);
    expect(await checkTag(right.authKey, tag, 'R', pubS, pubR)).toBe(false);
    expect(await checkTag(right.authKey, tag, 'S', pubR, pubS)).toBe(false);
    expect(await checkTag(right.authKey, 42, 'S', pubS, pubR)).toBe(false);
    expect(await checkTag(right.authKey, '!!not base64!!', 'S', pubS, pubR)).toBe(false);
  });
});

describe('public keys', () => {
  it('accepts a 65-byte uncompressed point and nothing else', async () => {
    const e = await makeEphemeral();
    expect(parsePublicKey(toBase64Url(e.pub))).toEqual(e.pub);
    expect(parsePublicKey(toBase64Url(new Uint8Array(64)))).toBeNull();
    expect(parsePublicKey(toBase64Url(new Uint8Array(65)))).toBeNull(); // first byte must be 4
    expect(parsePublicKey(7)).toBeNull();
    expect(parsePublicKey('@@@')).toBeNull();
  });
});

describe('the encrypted channel', () => {
  async function pair() {
    const r = await makeEphemeral();
    const s = await makeEphemeral();
    return { r, s, kR: await sessionKey(r, s.pub, r.pub, s.pub), kS: await sessionKey(s, r.pub, r.pub, s.pub) };
  }

  it('lets both ends read what the other sealed, and keeps the plaintext out of the envelope', async () => {
    const { kR, kS } = await pair();
    const sealed = await seal(kS, 'chan', 'data', { hello: 'SECRET-VALUE' });
    expect(JSON.stringify(sealed)).not.toContain('SECRET-VALUE');
    expect(await unseal(kR, 'chan', 'data', sealed)).toEqual({ hello: 'SECRET-VALUE' });
  });

  it('refuses a different channel, a different purpose, tampering, another session, and malformed envelopes', async () => {
    const { kR, kS } = await pair();
    const other = await pair();
    const sealed = await seal(kS, 'chan', 'data', { n: 1 });
    await expect(unseal(kR, 'other-chan', 'data', sealed)).rejects.toThrow();
    await expect(unseal(kR, 'chan', 'done', sealed)).rejects.toThrow();
    await expect(unseal(other.kR, 'chan', 'data', sealed)).rejects.toThrow();
    const flipped = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('AA') ? 'BB' : 'AA') };
    await expect(unseal(kR, 'chan', 'data', flipped)).rejects.toThrow();
    for (const bad of [null, 'x', 5, {}, { iv: 1, ct: 'x' }, { iv: 'AAAA', ct: 'AAAA' }]) {
      await expect(unseal(kR, 'chan', 'data', bad), JSON.stringify(bad).slice(0, 40)).rejects.toThrow();
    }
  });

  it('turns away a ciphertext over 64 KB before decrypting it', async () => {
    const { kR, kS } = await pair();
    const sealed = await seal(kS, 'chan', 'data', { n: 1 });
    // Well-formed base64url (a multiple of 4 characters), so only the size check can stop it before decrypt.
    const big = { iv: sealed.iv, ct: 'A'.repeat(MAX_MESSAGE_BYTES + 4) };
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      await expect(unseal(kR, 'chan', 'data', big)).rejects.toThrow();
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
  });

  it('cannot be opened with a key pair other than the two that made the session', async () => {
    const { r, s, kS } = await pair();
    const sealed = await seal(kS, 'chan', 'data', { v: 1 });
    const attacker = await makeEphemeral(); // knows the code, both public keys and the ciphertext, but neither private key
    const guess = await sessionKey(attacker, s.pub, r.pub, s.pub);
    await expect(unseal(guess, 'chan', 'data', sealed)).rejects.toThrow();
  });

  it('rejects a public key that is not on the curve', async () => {
    const r = await makeEphemeral();
    const bad = new Uint8Array(65).fill(1);
    bad[0] = 4;
    await expect(sessionKey(r, bad, r.pub, r.pub)).rejects.toThrow();
  });
});

describe('the payload', () => {
  it('builds version 1 with only the four fields', () => {
    const payload = buildPayload([{ ...entry(), extra: 'x' } as never]);
    expect(payload).toEqual({ v: 1, storms: [entry()] });
  });

  it('parses a good payload and accepts a null name', () => {
    expect(parsePayload({ v: 1, storms: [entry(), entry({ stormCode: 'WXYZ2345', name: null })] })).toHaveLength(2);
    expect(parsePayload({ v: 1, storms: [] })).toEqual([]);
  });

  it.each([
    ['null', null], ['a string', 'x'], ['wrong version', { v: 2, storms: [] }], ['no storms', { v: 1 }], ['storms not an array', { v: 1, storms: {} }],
    ['51 entries', { v: 1, storms: Array.from({ length: 51 }, (_, i) => entry({ stormCode: `ABCD${String(1000 + i)}` })) }],
    ['an entry that is not an object', { v: 1, storms: ['x'] }],
    ['an empty secret', { v: 1, storms: [entry({ secret: '' })] }],
    ['a huge secret', { v: 1, storms: [entry({ secret: 'S'.repeat(10_000) })] }],
    ['a huge code', { v: 1, storms: [entry({ stormCode: 'A'.repeat(500) })] }],
    ['a code with odd characters', { v: 1, storms: [entry({ stormCode: '<script>' })] }],
    ['a secret with odd characters', { v: 1, storms: [entry({ secret: 'not valid!!' })] }],
    ['a long name', { v: 1, storms: [entry({ name: 'N'.repeat(101) })] }],
    ['a non-string name', { v: 1, storms: [entry({ name: 5 })] }],
    ['a non-finite time', { v: 1, storms: [entry({ lastOpenedAt: Infinity })] }],
    ['a string time', { v: 1, storms: [entry({ lastOpenedAt: '1000' })] }],
    ['a negative time', { v: 1, storms: [entry({ lastOpenedAt: -1 })] }],
    ['duplicate codes', { v: 1, storms: [entry(), entry()] }],
  ])('rejects the whole payload for %s', (_label, value) => expect(parsePayload(value)).toBeNull());

  it('copies only the known fields, so a __proto__ key from JSON cannot reach the list', () => {
    const hostile = JSON.parse('{"v":1,"storms":[{"stormCode":"ABCD2345","secret":"abc","name":null,"lastOpenedAt":1,"__proto__":{"polluted":true}}]}');
    const parsed = parsePayload(hostile)!;
    expect(Object.keys(parsed[0]).sort()).toEqual(['lastOpenedAt', 'name', 'secret', 'stormCode']);
    // Copied with Object.assign or a setter, the key would have replaced the entry's prototype instead.
    expect(Object.getPrototypeOf(parsed[0])).toBe(Object.prototype);
    expect((parsed[0] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('leaves out of what it sends any entry the receiver would refuse, and repeated codes, so the rest still goes', () => {
    const payload = buildPayload([
      entry({ stormCode: 'GOOD2345' }),
      entry({ stormCode: 'LONG2345', name: 'N'.repeat(101) }),
      entry({ stormCode: 'BADS2345', secret: 'not valid!!' }),
      entry({ stormCode: 'TIME2345', lastOpenedAt: Number.NaN }),
      entry({ stormCode: 'GOOD2345', secret: 'other' }),
      entry({ stormCode: 'NULL2345', name: null }),
    ] as never);
    expect(payload.storms.map((e) => e.stormCode)).toEqual(['GOOD2345', 'NULL2345']);
    expect(parsePayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload.storms);
  });

  it('sends at most 50, counting only entries it keeps', () => {
    const list = [entry({ stormCode: 'BAD12345', secret: '' }), ...Array.from({ length: 60 }, (_, i) => entry({ stormCode: `OK${1000 + i}` }))];
    const payload = buildPayload(list as never);
    expect(payload.storms).toHaveLength(50);
    expect(payload.storms[0].stormCode).toBe('OK1000');
  });

  it('round-trips what the joiner sends back: its merge result and its merged list', () => {
    const done = buildDone({ added: 1, updated: 0, kept: 2 }, [entry()]);
    expect(parseDone(JSON.parse(JSON.stringify(done)))).toEqual({ result: { added: 1, updated: 0, kept: 2 }, storms: [entry()] });
  });

  it.each([
    ['null', null], ['no result', { list: { v: 1, storms: [] } }], ['no list', { result: { added: 0, updated: 0, kept: 0 } }],
    ['a negative count', { result: { added: -1, updated: 0, kept: 0 }, list: { v: 1, storms: [] } }],
    ['a text count', { result: { added: '1', updated: 0, kept: 0 }, list: { v: 1, storms: [] } }],
    ['a huge count', { result: { added: 1e9, updated: 0, kept: 0 }, list: { v: 1, storms: [] } }],
    ['a hostile list', { result: { added: 0, updated: 0, kept: 0 }, list: { v: 1, storms: [entry({ secret: '' })] } }],
  ])('rejects a done message with %s', (_label, value) => expect(parseDone(value)).toBeNull());
});
