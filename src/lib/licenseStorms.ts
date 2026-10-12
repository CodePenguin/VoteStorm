import { api } from '@/api';
import { generateAdminSecret } from '@/lib/adminKeys';
import type { LicensedStorm } from '@/shared/types';

// The Storms made under the loaded license. The license, not a Storm's secret, is what these calls rely on.

export async function listLicensedStorms(): Promise<LicensedStorm[]> {
  return (await api<{ storms: LicensedStorm[] }>('license-storms')).storms;
}

/** Takes a Storm over with a new secret made in this browser. Only the public key is sent; the old link stops working. */
export async function reclaimStorm(stormCode: string): Promise<{ stormCode: string; secret: string }> {
  const made = await generateAdminSecret();
  await api('license-storms', { method: 'POST', body: JSON.stringify({ stormCode, publicKey: made.publicKey, resultsKeyHash: made.resultsKeyHash }) });
  return { stormCode, secret: made.secret };
}

export function deleteLicensedStorm(stormCode: string) {
  return api('license-storms', { method: 'DELETE', body: JSON.stringify({ stormCode }) });
}
