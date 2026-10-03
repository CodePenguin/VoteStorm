const KEY = 'votestorm_license';

export function getStoredLicense(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setStoredLicense(jwt: string): void {
  localStorage.setItem(KEY, jwt);
}

export function clearStoredLicense(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
