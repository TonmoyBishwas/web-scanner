/**
 * Weight sanity check for an OCR'd carton weight.
 *
 * 2026-10-14, Glatt note 261058932: the worker's thumb covered the weight on
 * carton 1015651100101199069559412 and the OCR returned 120 kg, read from the
 * product name "שניצל עוף פרוס 120-מוסדי-קפוא" (schnitzel, 120 g portions).
 * The other 14 cartons of that item weighed 11.9–12.6 kg. The carton was
 * booked at 120 kg and the receipt went to Priority 108 kg over.
 *
 * Two independent signals, either one flags the carton for the worker
 * (`needs_review` → the edit panel → Save confirms or corrects). Nothing is
 * changed automatically: heavy drums of 150–200 kg are real (7290000002283).
 *
 *  1. The weight is a number printed in the product name that is NOT a kg
 *     quantity ("120-מוסדי", "30 גר'"). A name's "8 ק"ג" is the carton's real
 *     weight on many suppliers and is never flagged (31 real cartons).
 *  2. The weight is more than 3× (or under a third of) the median weight of
 *     the same item on the same list, once the item has 3+ weighed cartons —
 *     the median of 3+ is a majority, so one bad read cannot hide the others
 *     or drag them into a flag. On 1,219 booked cartons only the 120 kg one
 *     fails this.
 */
import { groupKeyForBox, type GroupableBox } from './group-key';

export const WEIGHT_RATIO_LIMIT = 3;
const MIN_GROUP = 3;

// A number immediately followed by a kg unit is a pack weight, not a label
// artefact: ק"ג / ק״ג / קג / ק'ג / קילו / kg.
const KG_AFTER = /^\s*(?:ק["'״׳]?ג|קילו|kg)/i;

/** Numbers in a product name that are not followed by a kg unit. */
export function nonKgNumbers(name: string | null | undefined): number[] {
  const s = name || '';
  const out: number[] = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const after = s.slice(m.index + m[0].length);
    if (KG_AFTER.test(after)) continue;
    // "6*3ק"ג" / "1X10 ק"ג": the multiplier before a kg pack is part of it.
    if (/^\s*[*xX×]\s*\d+(?:[.,]\d+)?\s*(?:ק["'״׳]?ג|קילו|kg)/i.test(after)) continue;
    out.push(Number(m[0].replace(',', '.')));
  }
  return out;
}

/** True when the weight equals a non-kg number printed in any of the names. */
export function weightFromName(weight: number, names: Array<string | null | undefined>): boolean {
  if (!(weight > 0)) return false;
  return names.some((n) => nonKgNumbers(n).some((v) => Math.abs(v - weight) < 0.001));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface WeighedBox extends GroupableBox {
  weight: number;
  ocr_status?: string;
  /** The worker saved this carton's weight in the edit panel — never re-flag it. */
  weight_checked?: boolean;
}

export interface WeightSuspect {
  barcode: string;
  weight: number;
  /** Median of the item on this list, when the ratio rule fired. */
  typical?: number;
  reason: 'name_number' | 'ratio';
}

/**
 * The cartons on one list (a pallet, or the loose list) whose weight looks
 * wrong. `names` gives extra names to test signal 1 against (the raw OCR
 * name, the matched invoice name) for a carton, by barcode.
 */
export function findWeightSuspects<B extends WeighedBox>(
  boxes: B[],
  extraNames: Record<string, Array<string | null | undefined>> = {},
): WeightSuspect[] {
  const out: WeightSuspect[] = [];
  const groups = new Map<string, B[]>();
  for (const b of boxes) {
    if (!(b.weight > 0) || (b.ocr_status && b.ocr_status !== 'done')) continue;
    const k = groupKeyForBox(b);
    const arr = groups.get(k);
    if (arr) arr.push(b); else groups.set(k, [b]);
  }
  for (const b of boxes) {
    if (b.weight_checked || !(b.weight > 0) || (b.ocr_status && b.ocr_status !== 'done')) continue;
    const names = [b.item_name_hebrew, b.item_name, ...(extraNames[b.barcode] ?? [])];
    if (weightFromName(b.weight, names)) {
      out.push({ barcode: b.barcode, weight: b.weight, reason: 'name_number' });
      continue;
    }
    const g = groups.get(groupKeyForBox(b)) ?? [];
    if (g.length < MIN_GROUP) continue;
    const typical = median(g.map((x) => x.weight));
    if (b.weight > typical * WEIGHT_RATIO_LIMIT || b.weight * WEIGHT_RATIO_LIMIT < typical) {
      out.push({ barcode: b.barcode, weight: b.weight, typical, reason: 'ratio' });
    }
  }
  return out;
}
