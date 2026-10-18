/**
 * One tab owns a scan session; any other tab on the same phone stops writing.
 *
 * 18/10 Glatt 261059464: every tap on the WhatsApp link opened a new Chrome
 * tab on the same /pallet-verify/<token>. Each tab kept its own carton list
 * and mirrored it into the ONE localStorage key for the pallet
 * (lib/pallet-scan-cache.ts), so whichever tab wrote last won. David scanned
 * 31 cartons in the newer tab, went back to the older one (still holding 38),
 * scanned there, and its first write replaced 69 with 39 — the 31 vanished
 * (95 of 130 shown, 126 scanned).
 *
 * Merging two live lists was tried and rejected (edits reverted, deletes and
 * rescans fighting, tabs rewriting each other). Instead, like WhatsApp Web:
 * the tab that opens last owns the session; an older tab that sees it lost the
 * session writes nothing more, and when the worker comes back to it, it
 * reloads — and the reload restores the owner's latest list from storage and
 * takes the session back.
 */

const PREFIX = 'pv';

/** Storage key holding the owning tab's id. Under the same `pv:<token>:`
 *  prefix as the snapshots, so clearAllScans removes it with them. */
export function ownerKey(token: string): string {
  return `${PREFIX}:${token}:owner`;
}

/** One id per page load. */
export function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** The minimal Storage surface used here (window.localStorage in the app). */
export interface OwnerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Take the session for this tab. False when the store refused the write
 *  (full / disabled): the caller then leaves ownership checks off. */
export function claimSession(store: OwnerStore | null, token: string, tab: string): boolean {
  if (!store) return false;
  try {
    store.setItem(ownerKey(token), tab);
    return store.getItem(ownerKey(token)) === tab;
  } catch {
    return false;
  }
}

/** The owning tab's id, or null (none / unreadable). */
export function sessionOwner(store: OwnerStore | null, token: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(ownerKey(token));
  } catch {
    return null;
  }
}

/** True when another tab took the session (or it was cleared: the pallet
 *  work finished elsewhere). Always false when this tab never got to claim. */
export function lostSession(store: OwnerStore | null, token: string, tab: string, claimed: boolean): boolean {
  if (!claimed) return false;
  return sessionOwner(store, token) !== tab;
}

export function browserStore(): OwnerStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
