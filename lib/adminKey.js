/** The admin key of a request. It travels in the `x-admin-key` header (or the JSON body), never in the URL, so it does not end up in access logs. */
export function adminKeyFrom(event, body = {}) {
  const header = event.headers?.['x-admin-key'] ?? event.headers?.['X-Admin-Key'];
  if (typeof header === 'string' && header) return header;
  return typeof body.adminKey === 'string' && body.adminKey ? body.adminKey : null;
}
