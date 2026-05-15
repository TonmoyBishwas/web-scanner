/**
 * Item-group key derivation for the pallet-verify scanner.
 *
 * The authoritative rule (from the user, 2026-05-15):
 *
 *   The barcode string on each box exists ONLY so we can detect that we're
 *   not scanning the same physical box twice. It carries no product
 *   information — each supplier uses their own barcode scheme, and we
 *   cannot derive SKU, weight, or expiry from the digits. Item grouping
 *   must rely on the OCR-extracted Hebrew name; weight is a secondary
 *   signal used for the uniform-pair detector.
 *
 * `groupKeyForBox` is the single source of truth for "are these two boxes
 *  the same item?" Prefer Hebrew name (this is an Israeli warehouse);
 *  fall back to English; final fallback to a stable `unknown:{barcode}`
 *  string so we never collapse OCR-failed boxes together.
 *
 * Co-located with the scanner because both `pallet-verify/[token]/page.tsx`
 * and `app/api/multi-pallet-complete/route.ts` need the same key
 * derivation. Bot side does not import this — the bot reads `item_name`
 * + `item_name_hebrew` fields out of the webhook payload directly.
 */
import { normalizeString } from './string-utils';
import type { MultiPalletBoxScan } from '@/types';

export type GroupableBox = Pick<MultiPalletBoxScan, 'barcode' | 'item_name' | 'item_name_hebrew'>;

export function groupKeyForBox(box: GroupableBox): string {
  const heb = normalizeString(box.item_name_hebrew);
  if (heb) return `he:${heb}`;
  const en = normalizeString(box.item_name);
  if (en) return `en:${en}`;
  // No OCR name yet (still processing) — fall back to the barcode so
  // each unnamed box stays in its own bucket until OCR finishes. Never
  // collide unnamed boxes from different physical scans.
  return `unknown:${box.barcode || 'anon'}`;
}

/**
 * Group an array of boxes by their item group key. Pure function — no
 * dependency on React state. Apply the optional `mergeMap` (originalKey
 * → canonicalKey) to honour AI-suggested merges the worker has accepted.
 */
export function groupBoxesByName<T extends GroupableBox>(
  boxes: T[],
  mergeMap?: Map<string, string>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const box of boxes) {
    const rawKey = groupKeyForBox(box);
    const key = mergeMap?.get(rawKey) ?? rawKey;
    const bucket = out.get(key);
    if (bucket) bucket.push(box);
    else out.set(key, [box]);
  }
  return out;
}
