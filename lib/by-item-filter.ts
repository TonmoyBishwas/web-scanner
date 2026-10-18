/**
 * "By item" view filter for the pallet-verify scan list.
 *
 * Pure logic only: which item chips to offer, how many cartons each one has,
 * and whether a carton passes the chosen filter. It is a VIEW filter — it
 * never decides what is booked, counted, deleted or sent; every action on the
 * page keeps acting on the full scan list.
 *
 * Items are grouped by the same key the uniform/mix logic uses for a product
 * (`groupKeyForBox`, with the worker-accepted AI merges applied), so a chip is
 * exactly one of the page's item groups. The one difference: every carton with
 * no OCR name yet (still reading, or unreadable) has its own `unknown:{barcode}`
 * group there — so two of them are never mistaken for the same product — but
 * here they share a single "Unidentified" chip, since a strip of one chip per
 * unread carton would be useless to filter by.
 */
import { groupKeyForBox, type GroupableBox } from './group-key';

/** The filter key of the shared "Unidentified" chip. */
export const UNIDENTIFIED_ITEM_KEY = 'unidentified';

export type ItemNameLang = 'he' | 'en';

export interface ItemChip {
  /** Filter key: the item group key, or UNIDENTIFIED_ITEM_KEY. */
  key: string;
  /** Display name in the worker's language (falls back to the other one);
   *  null for the Unidentified chip, whose label comes from i18n. */
  name: string | null;
  /** Cartons of this item in the scan list. */
  count: number;
}

/** The filter key a carton falls under. */
export function itemFilterKey(box: GroupableBox, mergeMap?: Map<string, string>): string {
  const raw = groupKeyForBox(box);
  if (raw.startsWith('unknown:')) return UNIDENTIFIED_ITEM_KEY;
  return mergeMap?.get(raw) ?? raw;
}

function nameIn(box: GroupableBox, lang: ItemNameLang): string {
  return ((lang === 'he' ? box.item_name_hebrew : box.item_name) || '').trim();
}

/**
 * One chip per distinct item, in the order the item was first scanned, with
 * the Unidentified chip (if any) last. The name is the first one found in the
 * worker's language among that item's cartons, else the first in the other.
 */
export function buildItemChips(
  boxes: GroupableBox[],
  lang: ItemNameLang,
  mergeMap?: Map<string, string>,
): ItemChip[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const names = new Map<string, { own: string; other: string }>();
  const other: ItemNameLang = lang === 'he' ? 'en' : 'he';

  for (const box of boxes) {
    const key = itemFilterKey(box, mergeMap);
    if (!counts.has(key)) {
      order.push(key);
      counts.set(key, 0);
      names.set(key, { own: '', other: '' });
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const n = names.get(key)!;
    if (!n.own) n.own = nameIn(box, lang);
    if (!n.other) n.other = nameIn(box, other);
  }

  const chips: ItemChip[] = order
    .filter((k) => k !== UNIDENTIFIED_ITEM_KEY)
    .map((key) => {
      const n = names.get(key)!;
      return { key, name: n.own || n.other || key.replace(/^(he|en):/, ''), count: counts.get(key) ?? 0 };
    });
  const unknown = counts.get(UNIDENTIFIED_ITEM_KEY);
  if (unknown) chips.push({ key: UNIDENTIFIED_ITEM_KEY, name: null, count: unknown });
  return chips;
}

/** Distinct identified items (the Unidentified chip is not an item). */
export function distinctItemCount(chips: ItemChip[]): number {
  return chips.filter((c) => c.key !== UNIDENTIFIED_ITEM_KEY).length;
}

/**
 * The filter that is actually in force: the chosen key while the list still
 * has a carton of that item, otherwise none (its cartons were all deleted, or
 * a new pallet started).
 */
export function effectiveItemFilter(selected: string | null, chips: ItemChip[]): string | null {
  if (!selected) return null;
  return chips.some((c) => c.key === selected) ? selected : null;
}

/** Does this carton show under the filter? No filter shows every carton. */
export function matchesItemFilter(
  box: GroupableBox,
  filter: string | null,
  mergeMap?: Map<string, string>,
): boolean {
  if (!filter) return true;
  return itemFilterKey(box, mergeMap) === filter;
}
