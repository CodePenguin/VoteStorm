import { getStoredLicense } from './licenseStorage';
import { beginActivity } from './composables/useActivity';
import { describeActivity, type ActivityLabels } from './lib/activity';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Only the presenter-side functions get the license; the audience never needs it.
const LICENSED_PATHS = ['create-storm', 'admin-storm', 'admin-questions', 'license-status'];
const usesLicense = (path: string) => LICENSED_PATHS.some((p) => path === p || path.startsWith(p + '?'));

export type ApiOptions = RequestInit & {
  /** Override the notice for this request, or false to keep it silent. By default it follows from the path and method. */
  activity?: ActivityLabels | false;
};

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { activity: activityOption, ...init } = options;
  const labels = activityOption === false ? null : (activityOption ?? describeActivity(path, init.method ?? 'GET', init.body));
  const finish = labels ? beginActivity(labels) : null;
  try {
    const license = usesLicense(path) ? getStoredLicense() : null;
    const res = await fetch(`/.netlify/functions/${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(license ? { authorization: `Bearer ${license}` } : {}), ...(init.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const body = data as { error?: string; code?: string };
      throw new ApiError(body.error || `Request failed: ${res.status}`, res.status, body.code);
    }
    finish?.({ ok: true });
    return data as T;
  } catch (err) {
    finish?.({ ok: false, message: (err as Error)?.message || 'Something went wrong' });
    throw err;
  }
}

function generateId(): string {
  // crypto.randomUUID() only exists in secure contexts; fall back so plain-HTTP LAN testing still works.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getDeviceId(): string {
  let id = localStorage.getItem('votestorm_device_id');
  if (!id) {
    id = generateId();
    localStorage.setItem('votestorm_device_id', id);
  }
  return id;
}
