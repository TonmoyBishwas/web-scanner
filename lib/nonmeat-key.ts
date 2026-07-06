import { normalizeString } from './string-utils';

/**
 * Stable per-item key for weight-based non-meat (Type A) carton accounting.
 *
 * The scanner scans one box per invoice item per pallet; an item's cartons may
 * span pallets, so we track how many are already committed keyed by this value.
 * Uses the invoice `item_code` when present, else `he:<normalized hebrew name>`.
 *
 * Pure + deterministic so the pallet-verify client (pre-fill of remaining) and
 * the multi-pallet-complete route (commit accumulation) key identically.
 */
export function nonMeatItemKey(item: {
  item_code?: string;
  item_name_hebrew?: string;
}): string {
  const code = (item.item_code || '').trim();
  if (code) return code;
  return 'he:' + normalizeString(item.item_name_hebrew);
}
