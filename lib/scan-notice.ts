/**
 * Scan notices — what a read that was NOT a failure tells the worker.
 *
 * pallet-verify used to have one persistent red `error` slot for everything:
 * a network failure, a session that expired, and a carton the camera simply
 * read a second time. On a pallet scanned in place the last one is the most
 * common event of the day (IN264172698 pallet 3: 22 of 32 reads), and it sat
 * in red for minutes ("Already scanned — this is carton #8 in the list
 * (15:09)"), naming the wrong carton after a later manual capture.
 *
 * So a read now produces one of:
 * - a NOTICE: blue "already counted" (nothing to do) or amber "misread, scan
 *   again" (one small action). It names the carton, highlights its row and
 *   clears itself after SCAN_NOTICE_MS.
 * - an ERROR (the page's `error`): red, persistent — the worker must act.
 *
 * The helpers here are the pure parts of that: which row a re-read refers to,
 * whether it is worth a sound, whether it may offer "Different carton?", and
 * where to scroll its row.
 */

import { isMintedLabelBarcode } from './label-batches';

/** How long a notice stays in the footer. */
export const SCAN_NOTICE_MS = 4000;

/** How long the carton a notice names stays highlighted in the list. */
export const HIGHLIGHT_ROW_MS = 2000;

/**
 * A camera parked on an already-counted sticker re-reads it every ~3.3 s (the
 * scanner's 3 s hold plus two reads). Re-reads of the same code inside this
 * window stay silent: the notice refreshes, the phone does not tick again.
 */
export const DUPLICATE_QUIET_MS = 15000;

/**
 * Should this re-read of an already-counted carton make a sound?
 *
 * Yes the first time, and again once the same code has gone unread for
 * `windowMs`. The window slides — every read restarts it — so a camera left
 * pointing at one sticker stays quiet however long it sits there. Records
 * `now` against the code in `last` as a side effect.
 */
export function shouldSoundDuplicate(
  last: Map<string, number>,
  barcode: string,
  now: number,
  windowMs: number = DUPLICATE_QUIET_MS,
): boolean {
  const prev = last.get(barcode);
  last.set(barcode, now);
  return prev === undefined || now - prev >= windowMs;
}

/**
 * Forget re-read times, so the next re-read sounds again: all of them (a new
 * pallet) or only some codes (a deleted row — re-scanning a carton after
 * deleting it must never be muted).
 */
export function clearDuplicateSounds(last: Map<string, number>, barcodes?: Iterable<string>): void {
  if (!barcodes) {
    last.clear();
    return;
  }
  for (const code of barcodes) last.delete(code);
}

/** The fields the lookups below read off a list row. */
interface CountedRow {
  barcode: string;
  /** The supplier code an "all boxes identical" row stands in for. */
  source_barcode?: string;
}

export interface CountedCarton<T> {
  /** 1-based carton number — the badge the list shows on the row. */
  n: number;
  row: T;
}

/**
 * The carton a re-read barcode refers to. A supplier code that an identical
 * batch stands in for points at the batch's first row: no row carries the
 * code itself any more.
 */
export function findCountedCarton<T extends CountedRow>(rows: ReadonlyArray<T>, code: string): CountedCarton<T> | null {
  const i = rows.findIndex((r) => r.barcode === code || r.source_barcode === code);
  return i === -1 ? null : { n: i + 1, row: rows[i] };
}

/**
 * The carton a manual capture's printed digits refer to: the FULL printed
 * number against every other row's barcode digits — never the 13-digit SKU,
 * which repeats on every carton of one product. `exceptBarcode` is the
 * capture's own provisional row.
 */
export function findCountedCartonByDigits<T extends CountedRow>(
  rows: ReadonlyArray<T>,
  digits: string,
  exceptBarcode?: string,
): CountedCarton<T> | null {
  if (!digits) return null;
  const i = rows.findIndex((r) => r.barcode !== exceptBarcode && r.barcode.replace(/\D/g, '') === digits);
  return i === -1 ? null : { n: i + 1, row: rows[i] };
}

/**
 * May an "already counted" notice offer "Different carton?"?
 *
 * The scanner dedupes on the full printed barcode, and some suppliers' labels
 * carry no serial: a 31-digit catch-weight label is GTIN + net weight in 10 g
 * steps + gross + expiry, so two physically different cartons of one pallet
 * can print byte-identical codes (about a coin flip on a 15-carton pallet).
 * Without a way in, the second one could not be booked at all. The offer is
 * an explicit tap that saves it a warehouse label of its own (see
 * IdenticalBoxesForm) — never an automatic second row.
 *
 * Not offered for a warehouse-minted `28…` label (unique per carton by
 * construction, so a re-read IS the same carton), for anything that is not a
 * real barcode (`MANUAL-…` / `NOBC-…`), or while the counted row is still in
 * OCR — the form would open with no name or weight to copy.
 */
export function canOfferDifferentCarton(code: string, row: { ocr_status?: string }): boolean {
  const c = (code || '').trim();
  if (!/^\d/.test(c) || isMintedLabelBarcode(c)) return false;
  return row.ocr_status !== 'processing';
}

/**
 * Where to scroll a list so a row is fully in view with the least movement
 * (`block: 'nearest'`), or null when it already is — or when the list is too
 * short to show it at all (a collapsed sheet: scrolling it would only hide
 * what little the worker can see). Plain numbers in the list's own
 * coordinates: `itemTop` is the row's offset from the top of the content.
 */
export function nearestScrollTop(
  itemTop: number,
  itemHeight: number,
  viewTop: number,
  viewHeight: number,
): number | null {
  if (viewHeight < itemHeight * 2) return null;
  if (itemTop < viewTop) return itemTop;
  if (itemTop + itemHeight > viewTop + viewHeight) return itemTop + itemHeight - viewHeight;
  return null;
}
