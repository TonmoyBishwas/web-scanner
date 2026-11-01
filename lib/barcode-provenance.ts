/**
 * Where a carton's barcode came from, and whether it passes its family's
 * format check (01/11, Glatt note 261062322 — client: "check the barcode
 * silently in the background; if it fails, mark it as unverified internally
 * and fix it later, never through David").
 *
 * Both go to the bot on every carton of pallet-complete and
 * loose-boxes-complete, as `barcode_source` and `barcode_format_ok`, for
 * box_inventory. Nothing here is shown to the worker.
 *
 *  - `scan`         — the camera's decoder read it;
 *  - `photo_digits` — a manual capture: the label photo's printed digits
 *                     (/api/multi-pallet-ocr `barcode_digits`);
 *  - `minted`       — an identifier made here: a `28…` warehouse label
 *                     (New carton, all boxes identical, a twin) or a
 *                     `NOBC-…` no-barcode marker;
 *  - `typed`        — the worker typed the digits in the edit panel.
 *
 * `barcode_format_ok`: lib/carton-barcode.ts barcodeFormatOk — null for a
 * minted identifier or a code with nothing to check.
 */
import { barcodeFormatOk } from './carton-barcode';
import { isMintedLabelBarcode } from './label-batches';
import { isNoBarcodeId } from './no-barcode';

export type BarcodeSource = 'scan' | 'photo_digits' | 'minted' | 'typed';

export const BARCODE_SOURCES: readonly BarcodeSource[] = ['scan', 'photo_digits', 'minted', 'typed'];

export interface ProvenanceRow {
  barcode: string;
  barcode_source?: BarcodeSource | string | null;
  minted?: boolean;
  twin?: boolean;
  new_carton?: boolean;
}

export function barcodeSourceOf(row: ProvenanceRow): BarcodeSource {
  const code = (row.barcode || '').trim();
  if (isMintedLabelBarcode(code) || isNoBarcodeId(code) || row.minted || row.twin || row.new_carton) return 'minted';
  const given = row.barcode_source;
  if (given && (BARCODE_SOURCES as readonly string[]).includes(given) && given !== 'minted') {
    return given as BarcodeSource;
  }
  return 'scan';
}

export function barcodeProvenance(row: ProvenanceRow): { barcode_source: BarcodeSource; barcode_format_ok: boolean | null } {
  const source = barcodeSourceOf(row);
  return {
    barcode_source: source,
    barcode_format_ok: source === 'minted' ? null : barcodeFormatOk(row.barcode),
  };
}

/**
 * Should a manual capture's row turn amber (the existing weight-doubt path:
 * the edit panel opens on the weight, beside the label photo)? When its
 * printed digits fail the format check and it has a weight to look at. A
 * capture with no weight from the photo or a barcode already holds as
 * "Weight not read" (needs_review) and opens the same panel — as today.
 * Never a block: a weight doubt only asks (lib/weight-review.ts).
 */
export function photoDigitsDoubt(digits: string, weight: number): boolean {
  return weight > 0 && barcodeFormatOk(digits) === false;
}
