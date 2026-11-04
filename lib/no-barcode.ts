/**
 * Cartons booked without a readable barcode.
 *
 * What such a carton is booked as. It has to be non-empty — the bot skips any
 * box whose barcode is falsy (`airtable_service.create_pallet_box_inventory`),
 * so an empty string would silently drop the carton out of `box_inventory` —
 * and it has to be visibly not-a-barcode so nothing ever tries to match it
 * against a scan. It is also the row's key on the scan list, so it must be
 * unique there.
 */
export const NO_BARCODE_PREFIX = 'NOBC-';

export function noBarcodeId(doc: string, pallet: number, n: number): string {
  return `${NO_BARCODE_PREFIX}${(doc || 'DOC').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}-P${pallet}-${n}`;
}

export function isNoBarcodeId(barcode: string | null | undefined): boolean {
  return !!barcode && barcode.startsWith(NO_BARCODE_PREFIX);
}

/**
 * `noBarcodeId(doc, pallet, n)` for the first n ≥ `preferred` not already a
 * barcode on the list. Position alone is not unique: after a delete, a later
 * carton can land on the slot an earlier marker was minted for.
 */
export function freeNoBarcodeId(
  doc: string,
  pallet: number,
  preferred: number,
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  let n = Math.max(1, Math.floor(preferred) || 1);
  while (used.has(noBarcodeId(doc, pallet, n))) n += 1;
  return noBarcodeId(doc, pallet, n);
}

/**
 * BOT-32 — a manual capture whose printed digits the OCR could not read.
 *
 * When the OCR still read the item name AND a positive weight, the carton is
 * captured: it is booked under a no-barcode marker with no warning. The
 * worker can still type the digits or create a label from the edit panel, but
 * nothing stops the pallet for it. Without a name or a weight the carton has
 * nothing to book, so it is held for review as before.
 *
 * `holdForReview` (scanner flag `manual_capture_review`, client 04/11: "stop
 * creating cartons with MANUAL barcodes until fixed"): a capture with a name
 * and a weight but no digits is NOT booked as NOBC- either — it is held
 * ('held_no_digits'), like any carton with no real barcode, until the worker
 * types the digits, takes a twin, creates a label or picks No barcode.
 */
export function unreadDigitsOutcome(
  read: {
    nameHebrew?: string | null;
    nameEnglish?: string | null;
    weightKg?: number | null;
  },
  opts: { holdForReview?: boolean } = {},
): 'book_without_barcode' | 'held_no_digits' | 'review' {
  const named = !!((read.nameHebrew || '').trim() || (read.nameEnglish || '').trim());
  const weighed = Number(read.weightKg) > 0;
  if (!(named && weighed)) return 'review';
  return opts.holdForReview ? 'held_no_digits' : 'book_without_barcode';
}

/** The placeholder a photo capture carries until it has a real identity. */
export const PROVISIONAL_PREFIX = 'MANUAL-';

export function isProvisionalId(barcode: string | null | undefined): boolean {
  return !!barcode && barcode.startsWith(PROVISIONAL_PREFIX);
}

/**
 * Under `manual_capture_review`: the rows a booking must not go out with —
 * every one still carrying its `MANUAL-` placeholder. The footer's gate
 * already holds such a row (it is needs_review), but two ways into the
 * booking pass it by: the single-item auto-confirm and, with meat
 * discrepancy on, "Create LPN anyway". Without the flag the page's last
 * line of defence turns them into NOBC- markers as before.
 */
export function provisionalAtBooking(
  rows: ReadonlyArray<{ barcode: string }>,
  holdForReview: boolean,
): string[] {
  if (!holdForReview) return [];
  return rows.filter((r) => isProvisionalId(r.barcode)).map((r) => r.barcode);
}
