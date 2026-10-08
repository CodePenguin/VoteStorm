import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

vi.mock('../../lib/stormCode.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateStormCode: vi.fn(actual.generateStormCode) };
});

import { generateStormCode } from '../../lib/stormCode.js';
import { createDb, initSchema } from '../../lib/db.js';
import { insertStorm } from '../../lib/storms.js';

const LICENSE = { id: 'anonymous', name: 'Anonymous', tier: 'anonymous', expiresAt: null, stormInactivityHours: 24 };
const RESULTS_KEY_HASH = 'a'.repeat(64);

async function newPublicKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
}

describe('storm code collisions', () => {
  let db;
  const takenCode = 'TAKEN234';
  const freshCode = 'FRESH567';

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'votestorm-test-'));
    db = createDb(`file:${path.join(dir, 'test.db')}`);
    await initSchema(db);
    // Another storm already holds takenCode.
    await db.execute({
      sql: `INSERT INTO storms (admin_key_hash, admin_public_key, storm_code, status, created_at, last_activity_at, license_json) VALUES (?, 'pk', ?, 'lobby', ?, ?, '{"id":"anonymous","name":"Anonymous","tier":"anonymous","expiresAt":null,"stormInactivityHours":24}')`,
      args: ['someone-elses-hash', takenCode, Date.now(), Date.now()],
    });
    generateStormCode.mockReset();
  });

  it('draws another code when the code is already in use', async () => {
    generateStormCode.mockReturnValueOnce(takenCode).mockReturnValueOnce(takenCode).mockReturnValueOnce(freshCode);
    const result = await insertStorm(db, LICENSE, { publicKey: await newPublicKey(), resultsKeyHash: RESULTS_KEY_HASH });
    expect(result).toEqual({ stormCode: freshCode });
    expect(generateStormCode).toHaveBeenCalledTimes(3);
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(2);
  });

  it('gives up with null if it keeps colliding', async () => {
    generateStormCode.mockReturnValue(takenCode);
    const result = await insertStorm(db, LICENSE, { publicKey: await newPublicKey(), resultsKeyHash: RESULTS_KEY_HASH });
    expect(result).toBeNull();
    expect(generateStormCode).toHaveBeenCalledTimes(5);
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM storms')).rows[0].n)).toBe(1);
  });

  it('reports a public key that already belongs to a Storm as in use', async () => {
    generateStormCode.mockReturnValue(freshCode);
    const publicKey = await newPublicKey();
    expect(await insertStorm(db, LICENSE, { publicKey, resultsKeyHash: RESULTS_KEY_HASH })).toEqual({ stormCode: freshCode });
    generateStormCode.mockReturnValue('OTHER234');
    expect(await insertStorm(db, LICENSE, { publicKey, resultsKeyHash: RESULTS_KEY_HASH })).toEqual({ inUse: true });
  });
});
