import { LicenseError, describeLicense, resolveLicense } from '../../lib/license.js';
import { json } from '../../lib/http.js';

// Tells the presenter which license (or the anonymous tier) their token puts them under.
export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  try {
    return json(200, describeLicense(await resolveLicense(event)));
  } catch (err) {
    if (err instanceof LicenseError) return json(401, { error: err.message, code: 'license_invalid' });
    throw err;
  }
}
