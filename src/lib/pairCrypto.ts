import { fromBase64Url, subtle, toBase64Url } from '@/lib/adminKeys';
import { MAX_RECENT, type RecentStorm } from '@/lib/recentStorms';

// The building blocks of syncing the Storms list between devices (the protocol is in pairing.ts). Everything is derived from a short code
// that is typed on one device and never sent anywhere: the code names the channel and keys a MAC that proves a device knows it,
// while the payload itself is encrypted with a key from a fresh ECDH exchange, so a recording of the traffic plus the code
// still cannot be decrypted.

export const CODE_LENGTH = 10;
export const MAX_MESSAGE_BYTES = 64 * 1024;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Names this protocol and its version wherever a key is derived: the HKDF salt for the code's keys, the HKDF info for the session key.
const PROTOCOL_LABEL = 'votestorm-pair-v1';
const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** 10 characters, 5 bits each. 256 is a multiple of 32, so there is no modulo bias. */
export function generateCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => ALPHABET[b % 32]).join('');
}

export const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** What was typed, as a code, or null when it cannot be one. Case, spaces, hyphens and look-alike letters do not matter. */
export function normalizeCode(input: string): string | null {
  const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return text.length === CODE_LENGTH && [...text].every((c) => ALPHABET.includes(c)) ? text : null;
}

export interface CodeKeys {
  channelId: string;
  authKey: CryptoKey;
}

export async function deriveFromCode(code: string): Promise<CodeKeys> {
  const base = await subtle().importKey('raw', encoder.encode(code), 'HKDF', false, ['deriveBits']);
  const bits = (info: string) => subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(PROTOCOL_LABEL), info: encoder.encode(info) }, base, 256);
  const [channel, auth] = [await bits('channel'), await bits('auth')];
  const authKey = await subtle().importKey('raw', auth, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { channelId: toHex(channel), authKey };
}

export interface Ephemeral {
  pub: Uint8Array;
  privateKey: CryptoKey;
}

/** A fresh ECDH key pair for one pairing. The private half is not extractable and never leaves this call's owner. */
export async function makeEphemeral(): Promise<Ephemeral> {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { pub: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)), privateKey: pair.privateKey };
}

/** A 65-byte uncompressed P-256 point from base64url text, or null. (Whether it is on the curve is checked when it is used.) */
export function parsePublicKey(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  try {
    const bytes = fromBase64Url(text);
    return bytes.length === 65 && bytes[0] === 4 ? bytes : null;
  } catch {
    return null;
  }
}

const tagInput = (label: 'R' | 'S', parts: Uint8Array[]) => concat([encoder.encode(label), ...parts]);

/** Proof of knowing the code: R tags the joiner's public key, S the host's key followed by the joiner's. */
export async function makeTag(authKey: CryptoKey, label: 'R' | 'S', ...parts: Uint8Array[]): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().sign('HMAC', authKey, tagInput(label, parts))));
}

export async function checkTag(authKey: CryptoKey, tag: unknown, label: 'R' | 'S', ...parts: Uint8Array[]): Promise<boolean> {
  if (typeof tag !== 'string' || tag.length > 100) return false;
  try {
    return await subtle().verify('HMAC', authKey, fromBase64Url(tag), tagInput(label, parts));
  } catch {
    return false;
  }
}

/** The AES-GCM key both devices reach from the ECDH secret. The code is not an input, so knowing it later reveals nothing. */
export async function sessionKey(mine: Ephemeral, theirPub: Uint8Array, pubR: Uint8Array, pubS: Uint8Array): Promise<CryptoKey> {
  const theirs = await subtle().importKey('raw', theirPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: theirs }, mine.privateKey, 256);
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(await subtle().digest('SHA-256', concat([pubR, pubS])));
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(PROTOCOL_LABEL) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface Sealed {
  iv: string;
  ct: string;
}

// The channel id and the purpose are authenticated with the ciphertext, so a message cannot be moved to another channel or
// replayed as a different message type (for example the data message handed back as "done").
const aad = (channelId: string, purpose: string) => encoder.encode(`${channelId}|${purpose}`);

export async function seal(key: CryptoKey, channelId: string, purpose: 'data' | 'done', value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(channelId, purpose) }, key, encoder.encode(JSON.stringify(value)));
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

/** The JSON value inside a sealed message. Throws on anything that is not exactly what `seal` produced for this key, channel and purpose. */
export async function unseal(key: CryptoKey, channelId: string, purpose: 'data' | 'done', sealed: unknown): Promise<unknown> {
  const s = sealed as Partial<Sealed> | null;
  if (!s || typeof s.iv !== 'string' || typeof s.ct !== 'string' || s.iv.length > 32 || s.ct.length > MAX_MESSAGE_BYTES) throw new Error('not a sealed message');
  const iv = fromBase64Url(s.iv);
  if (iv.length !== 12) throw new Error('not a sealed message');
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad(channelId, purpose) }, key, fromBase64Url(s.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

const isText = (v: unknown, max: number, pattern: RegExp): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && pattern.test(v);

/** One entry rebuilt from its four known fields, or null when the receiving side would refuse it. */
function toEntry(raw: unknown): RecentStorm | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') return null;
  const { stormCode, secret, name, lastOpenedAt } = e;
  if (!isText(stormCode, 32, /^[A-Za-z0-9]+$/) || !isText(secret, 256, /^[A-Za-z0-9_-]+$/)) return null;
  if (name !== null && (typeof name !== 'string' || name.length > 100)) return null;
  if (typeof lastOpenedAt !== 'number' || !Number.isFinite(lastOpenedAt) || lastOpenedAt < 0) return null;
  return { stormCode, secret, name: name as string | null, lastOpenedAt };
}

/**
 * What is sent: at most 50 Storms with only the four fields. An entry the other device would refuse (a corrupted one, say, or a
 * repeated code) is left out here, since one bad entry makes the receiver turn away the whole list.
 */
export function buildPayload(storms: RecentStorm[]): { v: 1; storms: RecentStorm[] } {
  const out: RecentStorm[] = [];
  const seen = new Set<string>();
  for (const raw of storms) {
    if (out.length === MAX_RECENT) break;
    const e = toEntry(raw);
    if (!e || seen.has(e.stormCode)) continue;
    seen.add(e.stormCode);
    out.push(e);
  }
  return { v: 1, storms: out };
}

/**
 * The Storms in a received payload, or null when anything about it is wrong. The other device is one the code vouched for, but
 * the data is still treated as hostile: bounded, typed, and rebuilt field by field so nothing else gets through.
 */
export function parsePayload(value: unknown): RecentStorm[] | null {
  const p = value as { v?: unknown; storms?: unknown } | null;
  if (!p || typeof p !== 'object' || p.v !== 1 || !Array.isArray(p.storms) || p.storms.length > MAX_RECENT) return null;
  const out: RecentStorm[] = [];
  const seen = new Set<string>();
  for (const raw of p.storms) {
    const e = toEntry(raw);
    if (!e || seen.has(e.stormCode)) return null;
    seen.add(e.stormCode);
    out.push(e);
  }
  return out;
}

type Counts = { added: number; updated: number; kept: number };

/** What the joiner sends back after merging: how it went, and the list it now holds (so the host can merge it too). */
export function buildDone(result: Counts, storms: RecentStorm[]): { result: Counts; list: { v: 1; storms: RecentStorm[] } } {
  return { result, list: buildPayload(storms) };
}

export function parseDone(value: unknown): { result: Counts; storms: RecentStorm[] } | null {
  const d = value as { result?: Record<string, unknown> | null; list?: unknown } | null;
  const r = d?.result;
  if (!d || typeof d !== 'object' || !r || typeof r !== 'object') return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_RECENT;
  if (!ok(r.added) || !ok(r.updated) || !ok(r.kept)) return null;
  const storms = parsePayload(d.list);
  return storms ? { result: { added: r.added, updated: r.updated, kept: r.kept }, storms } : null;
}
