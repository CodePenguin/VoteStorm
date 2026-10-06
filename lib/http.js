export function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}
