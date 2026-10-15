/**
 * Which list rows a sticker photo belongs to (2026-10-15, problem e / gap G2).
 *
 * The page uploads a carton's captured frame in the background and patches
 * the resulting URL onto its row. Two things went wrong:
 *  - the "already uploaded" guard was keyed by barcode for the whole page, so
 *    pallet 2's sample of a product already photographed on pallet 1 never
 *    uploaded (IN26013461: no photo on P2);
 *  - the patch matched `barcode === sample` only, so once "all boxes
 *    identical" had replaced the sample with minted `28…` rows (whose
 *    `source_barcode` is the sample) before the upload finished, the URL
 *    landed nowhere (10-14: 62 of 72 minted cartons without a photo).
 */

/** One upload per row: list (pallet n / loose) + barcode. Cleared on delete. */
export function photoUploadKey(target: 'pallet' | 'loose', pallet: number, barcode: string): string {
  return `${target}:${target === 'loose' ? 0 : pallet}:${barcode}`;
}

type PhotoRow = { barcode: string; source_barcode?: string; twin?: boolean };

/**
 * Does the photo uploaded for `barcode` belong on this row? The row itself,
 * or a row minted to stand in for it ("all boxes identical" / New carton
 * copies of the sample). A twin ("another carton, same label") is a
 * different physical carton, so it does not borrow the sample's picture.
 */
export function photoBelongsTo(row: PhotoRow, barcode: string): boolean {
  if (row.barcode === barcode) return true;
  return !row.twin && !!row.source_barcode && row.source_barcode === barcode;
}
