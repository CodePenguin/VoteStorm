// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { webcrypto, createHash, createPublicKey, verify } from 'node:crypto';
import { generateAdminSecret, describeSecret, importSigner, fromBase64Url } from '@/lib/adminKeys';
import { canonicalText } from '@/lib/adminRequest';
import vector from '../fixtures/admin-signature-vector.json';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('generateAdminSecret', () => {
  it('returns a secret and the values derived from it', async () => {
    const made = await generateAdminSecret();
    expect(made.secret).toMatch(/^[A-Za-z0-9_-]{128}$/);
    const pub = fromBase64Url(made.publicKey);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(made.resultsKey).toMatch(/^[0-9a-f]{24}$/);
    expect(made.resultsKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.resultsKeyHash).toBe(createHash('sha256').update('results:' + made.resultsKey).digest('hex'));
  });

  it('makes a different secret each time', async () => {
    const a = await generateAdminSecret();
    const b = await generateAdminSecret();
    expect(a.secret).not.toBe(b.secret);
  });

  it('explains that a secure connection is needed when WebCrypto is missing', async () => {
    vi.stubGlobal('crypto', {});
    try {
      await expect(generateAdminSecret()).rejects.toThrow('secure connection');
    } finally {
      vi.stubGlobal('crypto', webcrypto);
    }
  });
});

describe('describeSecret', () => {
  it('derives the same values every time', async () => {
    const made = await generateAdminSecret();
    expect(await describeSecret(made.secret)).toEqual(made);
  });

  it('rejects a secret that is not valid', async () => {
    await expect(describeSecret('short')).rejects.toThrow();
  });
});

describe('importSigner', () => {
  it('is not extractable', async () => {
    const made = await generateAdminSecret();
    const signer = await importSigner(made.secret);
    expect(signer.extractable).toBe(false);
  });

  it('signs the canonical text so the public key verifies it', async () => {
    const made = await generateAdminSecret();
    const signer = await importSigner(made.secret);
    const text = vector.canonicalText;
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, new TextEncoder().encode(text)));
    const pub = fromBase64Url(made.publicKey);
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });
});

describe('canonicalText', () => {
  it('matches the shared vector', async () => {
    expect(await canonicalText(vector.input)).toBe(vector.canonicalText);
  });
});
