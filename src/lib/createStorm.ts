import { api } from '@/api';
import { generateAdminSecret } from '@/lib/adminKeys';
import type { AdminSession } from '@/lib/adminRequest';

/** Makes a new presenter secret in this browser and registers only its public key. */
export async function createStorm(): Promise<AdminSession> {
  const made = await generateAdminSecret();
  const data = await api<{ stormCode: string }>('create-storm', { method: 'POST', body: JSON.stringify({ publicKey: made.publicKey, resultsKeyHash: made.resultsKeyHash }) });
  return { stormCode: data.stormCode, secret: made.secret };
}
