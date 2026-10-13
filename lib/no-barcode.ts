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
 */
export function unreadDigitsOutcome(read: {
  nameHebrew?: string | null;
  nameEnglish?: string | null;
  weightKg?: number | null;
}): 'book_without_barcode' | 'review' {
  const named = !!((read.nameHebrew || '').trim() || (read.nameEnglish || '').trim());
  const weighed = Number(read.weightKg) > 0;
  return named && weighed ? 'book_without_barcode' : 'review';
}
