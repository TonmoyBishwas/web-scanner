/**
 * A carton whose label read failed must not be booked blind (S03, 23/10).
 *
 * Carton C13 of document S03: the box OCR stalled (Gemini, 40.9 s) and the
 * row came back `ocr_status: 'failed'` — no name, weight 0, no expiry. The
 * confirm gate only counted `needs_review` rows, so the worker swiped the
 * pallet through; the last barcode pass skips rows that are not 'done', the
 * nameless row became a group of its own, SCN-11 left that group out of
 * `items`, and the bot stored the carton under no pallet item. The chicken
 * line was booked 14 cartons / 171.74 kg instead of 15 / 184.31.
 *
 * Four guards, none with a word of new text:
 *
 *  * `blocksConfirm` — a failed read holds confirm exactly like a
 *    `needs_review` row (pallet and loose), and the amber "needs a detail"
 *    footer opens it. A row still being read is NOT counted: it is not
 *    missing a detail yet.
 *  * `waitForReads` / `heldAfterReads` — the confirm waits (bounded) for
 *    reads still in flight, and anything that comes back failed or flagged
 *    sends the worker back to the list instead of being booked. Without this
 *    a swipe during a 40 s stall books the same blank carton.
 *  * `failedReadPrefill` — a failed row keeps what the scanner already
 *    knows: the 31-digit barcode's weight and expiry (lib/barcode-reconcile.ts,
 *    marked "from barcode", never `weight_checked`) and the invoice line its
 *    own code names (matchInvoiceItemByCode — an exact, unique code match
 *    only). It stays 'failed', so the gate still makes the worker look; one
 *    Save resolves it.
 *  * `snapNamelessByCode` — the completion route gives a nameless row the
 *    name of the invoice line its code is (same rule), for any path that
 *    still books one (the soft force-confirm, an old cached page).
 */

import { reconcileWithBarcode, type BarcodeEvent, type BarcodeFilled } from './barcode-reconcile';
import { cartonOwnCodes, matchInvoiceItemByCode, type InvoiceItem } from './invoice-match';

/** How long a confirm waits for label reads still in flight before it books. */
export const READ_WAIT_BEFORE_BOOK_MS = 30_000;
const READ_WAIT_POLL_MS = 250;

/**
 * Does this row hold the pallet (or the loose pile) from being confirmed?
 * The one predicate the gate's count and the amber footer's "open it" share.
 */
export function blocksConfirm(b: { needs_review?: boolean; ocr_status?: string }): boolean {
  return !!b.needs_review || b.ocr_status === 'failed';
}

/**
 * Resolves true once `pending()` is false, polling every `pollMs`; false
 * when it is still true after `timeoutMs`.
 */
export function waitForReads(
  pending: () => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READ_WAIT_BEFORE_BOOK_MS;
  const pollMs = opts.pollMs ?? READ_WAIT_POLL_MS;
  if (!pending()) return Promise.resolve(true);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!pending()) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  });
}

/**
 * After the wait: the barcodes that send the confirm back to the list.
 * A row the confirm waited for that now blocks (nobody has seen it yet —
 * not even in soft mode), and, where warnings block, any failed row at all
 * (a confirm that never passed the footer's gate: the single-item
 * auto-confirm after the total is set).
 */
export function heldAfterReads(
  rows: ReadonlyArray<{ barcode: string; needs_review?: boolean; ocr_status?: string }>,
  waitedFor: ReadonlySet<string>,
  opts: { soft: boolean },
): string[] {
  return rows
    .filter((r) => blocksConfirm(r) && (waitedFor.has(r.barcode) || (!opts.soft && r.ocr_status === 'failed')))
    .map((r) => r.barcode);
}

/**
 * May a label read's answer still land on this row? The confirm fails a read
 * still out after READ_WAIT_BEFORE_BOOK_MS, but the fetch runs on (the OCR
 * route waits up to 55 s; S03's took 42.6 s). Once the worker has opened the
 * failed row and saved it ('done'), a late failure must not fail it again
 * and a late success must not overwrite his name and weight.
 */
export function takesLateRead(b: { ocr_status?: string }): boolean {
  return b.ocr_status === 'processing' || b.ocr_status === 'failed';
}

export interface FailedReadRow {
  barcode: string;
  source_barcode?: string;
  named_by_worker?: boolean;
  captured_via?: 'scan' | 'manual';
  item_name?: string;
  item_name_hebrew?: string;
  weight: number;
  expiry?: string;
  weight_checked?: boolean;
  expiry_checked?: boolean;
  barcode_filled?: BarcodeFilled;
}

export interface FailedReadPatch {
  weight?: number;
  expiry?: string;
  barcode_filled?: BarcodeFilled;
  item_name?: string;
  item_name_hebrew?: string;
}

const blank = (v: string | null | undefined) => !(v || '').trim();

/**
 * What a scanned carton whose label read just failed can still be given:
 * weight and expiry from its 31-digit barcode, the name of the invoice line
 * its own code is. Empty for a photo capture (its code is a placeholder or
 * the OCR's digits). `events` are the barcode fills, for scanner_events.
 */
export function failedReadPrefill(
  row: FailedReadRow,
  invoiceItems: InvoiceItem[] | undefined,
  opts: { receivedIso: string; typicalKg?: number | null },
): { patch: FailedReadPatch; events: BarcodeEvent[] } {
  const patch: FailedReadPatch = {};
  if (row.captured_via === 'manual') return { patch, events: [] };

  const r = reconcileWithBarcode(
    row.barcode,
    { weight: row.weight, expiry: row.expiry },
    { receivedIso: opts.receivedIso, typicalKg: opts.typicalKg, trusted: true },
  );
  const filled: BarcodeFilled = {};
  const events: BarcodeEvent[] = [];
  if (!row.weight_checked && 'weight' in r.filled && r.weight !== null) {
    patch.weight = r.weight;
    filled.weight = r.filled.weight;
    events.push(...r.events.filter((e) => e.field === 'weight'));
  }
  if (!row.expiry_checked && 'expiry' in r.filled && r.expiry !== null) {
    patch.expiry = r.expiry;
    filled.expiry = r.filled.expiry;
    events.push(...r.events.filter((e) => e.field === 'expiry'));
  }
  if ('weight' in filled || 'expiry' in filled) patch.barcode_filled = { ...row.barcode_filled, ...filled };

  if (blank(row.item_name) && blank(row.item_name_hebrew)) {
    const line = matchInvoiceItemByCode(cartonOwnCodes(row), invoiceItems);
    if (line) {
      patch.item_name = line.item_name_english || '';
      patch.item_name_hebrew = line.item_name_hebrew || '';
    }
  }
  return { patch, events };
}

/**
 * The completion route's copy of the name rule: each row with no name whose
 * own code is exactly one invoice line's item code takes that line's names,
 * so it groups (and is booked) with that line instead of becoming a nameless
 * group SCN-11 drops. Every other row passes through as the same object.
 */
export function snapNamelessByCode<T extends { barcode: string; item_name?: string; item_name_hebrew?: string }>(
  boxes: T[],
  invoiceItems: InvoiceItem[] | undefined,
): { boxes: T[]; snapped: string[] } {
  const snapped: string[] = [];
  const out = boxes.map((b) => {
    if (!blank(b.item_name) || !blank(b.item_name_hebrew)) return b;
    const line = matchInvoiceItemByCode(cartonOwnCodes(b), invoiceItems);
    if (!line) return b;
    snapped.push(b.barcode);
    return { ...b, item_name: line.item_name_english || '', item_name_hebrew: line.item_name_hebrew || '' };
  });
  return { boxes: out, snapped };
}
