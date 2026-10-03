import { getStoredLicense } from './licenseStorage';

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
const LICENSED_PATHS = ['create-room', 'admin-room', 'admin-questions', 'license-status'];
const usesLicense = (path: string) => LICENSED_PATHS.some((p) => path === p || path.startsWith(p + '?'));

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const license = usesLicense(path) ? getStoredLicense() : null;
  const res = await fetch(`/.netlify/functions/${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(license ? { authorization: `Bearer ${license}` } : {}), ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { error?: string; code?: string };
    throw new ApiError(body.error || `Request failed: ${res.status}`, res.status, body.code);
  }
  return data as T;
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
