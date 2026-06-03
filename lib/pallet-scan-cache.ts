/**
 * Browser-side cache for in-progress pallet-verify scans.
 *
 * The multi-pallet inbound screen keeps the scanned-box list in client-only
 * React state and only sends the finished pallet to the server. That means a
 * page reload mid-pallet used to wipe the worker's scans. This module persists
 * the in-progress snapshot to `localStorage` (keyed by session token + pallet)
 * so a reload/refresh/crash on the SAME phone restores everything.
 *
 * The helpers are intentionally type-agnostic: the page builds/consumes the
 * snapshot with its own local types and is responsible for stripping the large
 * base64 `image_data` from boxes before saving (localStorage has a ~5 MB quota).
 * All access is wrapped in try/catch so a full or unavailable store can never
 * break scanning.
 */

const PREFIX = 'pv';

function palletKey(token: string, pallet: number): string {
  return `${PREFIX}:${token}:p${pallet}`;
}

function looseKey(token: string): string {
  return `${PREFIX}:${token}:loose`;
}

function read<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded / private mode / disabled — degrade silently. Scanning
    // continues from React state; only reload-restore is lost.
  }
}

function remove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function savePalletScans(token: string, pallet: number, snapshot: unknown): void {
  write(palletKey(token, pallet), snapshot);
}

export function loadPalletScans<T = unknown>(token: string, pallet: number): T | null {
  return read<T>(palletKey(token, pallet));
}

export function clearPalletScans(token: string, pallet: number): void {
  remove(palletKey(token, pallet));
}

export function saveLooseScans(token: string, snapshot: unknown): void {
  write(looseKey(token), snapshot);
}

export function loadLooseScans<T = unknown>(token: string): T | null {
  return read<T>(looseKey(token));
}

/** Remove every cached snapshot for this session token (pallets + loose). */
export function clearAllScans(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const tokenPrefix = `${PREFIX}:${token}:`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(tokenPrefix)) keys.push(k);
    }
    keys.forEach((k) => remove(k));
  } catch {
    /* ignore */
  }
}
