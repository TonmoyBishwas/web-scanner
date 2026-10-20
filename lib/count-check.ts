import { matchInvoiceItem, type InvoiceItem } from './invoice-match';
import { isNoBarcodeId } from './no-barcode';

/**
 * The pallet total against the open list (document 48429, 19/10).
 *
 * David's pallet held 22 drumstick cartons. Their only codes were 6 digits,
 * so he photo-captured 3 (each booked as a no-barcode NOBC-* row) and then
 * saved 22 New carton labels — one per carton on the pallet, the 3 included.
 * The list held 25. He typed the real 22 and the scanner refused it ("the
 * total must be at least 25"), so he typed 25, and 3 cartons that never
 * existed went to Priority.
 *
 * The scanner no longer refuses a total below the list. It says plainly what
 * it sees — "25 cartons on the list, you entered 22" — and offers the ways
 * forward: remove the extra cartons (selection mode), keep the list's count,
 * or fix the number. Nothing is dropped or counted for him: each way is a tap.
 *
 * The New carton form (CartonCreator) uses `cartonsOnListFor` the other way
 * round: before he types how many labels, it shows the cartons of that item
 * already on the list and offers only the rest — so the same carton is not
 * counted twice in the first place.
 */

interface Row {
  barcode: string;
  item_name?: string;
  item_name_hebrew?: string;
}

export interface ListAboveTotal {
  /** The total the worker entered. */
  declared: number;
  /** Cartons on the open list (rows: a single-item group counts its samples). */
  onList: number;
  /** onList − declared. */
  extra: number;
  /**
   * Rows to tick for him when selection mode opens: the no-barcode photo
   * captures, but only when there are exactly `extra` of them — the 48429
   * shape (photo + label for the same cartons). Any other mix is his call,
   * nothing is pre-ticked. A tick deletes nothing: "Delete selected" does.
   */
  suggested: string[];
}

/** The list holds more cartons than the declared total, or null. */
export function listAboveTotal(declared: number, rows: ReadonlyArray<Row>): ListAboveTotal | null {
  if (!Number.isFinite(declared) || declared < 1) return null;
  const onList = rows.length;
  if (onList <= declared) return null;
  const extra = onList - declared;
  const noBarcode = rows.filter((r) => isNoBarcodeId(r.barcode)).map((r) => r.barcode);
  return { declared, onList, extra, suggested: noBarcode.length === extra ? noBarcode : [] };
}

export interface OnListForItem {
  /** Cartons on the open list that are this item. */
  total: number;
  /** Of those, booked without a barcode (photo capture, NOBC-*). */
  noBarcode: number;
}

/**
 * Cartons of one invoice line already on the open list. A row counts when
 * its names match that line; on a one-line note every row is that line's
 * (there is nothing else it could be), matched or not — a photo capture
 * whose OCR name drifted is the very carton that would be counted twice.
 */
export function cartonsOnListFor(
  itemCode: string | null | undefined,
  rows: ReadonlyArray<Row>,
  lines: ReadonlyArray<InvoiceItem> | null | undefined,
): OnListForItem {
  const all = lines ? [...lines] : [];
  const code = String(itemCode ?? '');
  if (!code || all.length === 0) return { total: 0, noBarcode: 0 };
  const oneLine = all.length === 1 && String(all[0].item_code ?? '') === code;
  let total = 0;
  let noBarcode = 0;
  for (const r of rows) {
    const hit = oneLine || String(matchInvoiceItem(r.item_name_hebrew, r.item_name, all)?.item_code ?? '') === code;
    if (!hit) continue;
    total += 1;
    if (isNoBarcodeId(r.barcode)) noBarcode += 1;
  }
  return { total, noBarcode };
}

export interface NewCartonQuantity {
  /** What the quantity field opens on. */
  quantity: number;
  /** The note line's cartons not on the list yet; null when not knowable. */
  left: number | null;
}

/**
 * What New carton's "how many" opens on for an item with `onList` cartons
 * already on the list. Nothing on the list: 1, as before (one torn sticker
 * is the common case). Some on the list and the line's carton count is this
 * pallet's (no other pallet, no loose pile): the rest of the line — "3
 * already on the list, how many MORE?" — never below 1. Otherwise 1; the
 * line's figure can't be split across pallets from here.
 */
export function newCartonQuantity(opts: {
  onList: number;
  lineBoxes: number | null | undefined;
  lineMaySpread: boolean;
}): NewCartonQuantity {
  const boxes = Math.floor(Number(opts.lineBoxes) || 0);
  const onList = Math.max(0, Math.floor(opts.onList) || 0);
  const left = boxes > 0 && !opts.lineMaySpread ? Math.max(0, boxes - onList) : null;
  if (onList === 0 || left === null) return { quantity: 1, left };
  return { quantity: Math.max(1, left), left };
}
