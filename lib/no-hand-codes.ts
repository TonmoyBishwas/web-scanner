/**
 * No hand-made carton codes (Mevaser 05/11, scanner flag `no_hand_codes`).
 *
 * Decision 2: "Operators never create codes by hand. Remove the 'create
 * barcode' button and the MANUAL placeholders in every mode." Decision 5:
 * at 12:14 UTC 04/11 (Glatt 261063350) four cartons read with real, unique
 * Glatt barcodes but no weight were deleted and 50 New-carton labels at 8 kg
 * booked instead — "a real carton barcode with a missing weight should lead
 * to 'type the weight', never to 'delete and create'".
 *
 * With the flag on:
 *  - a carton booked with no readable barcode goes out with barcode '' —
 *    box_inventory.barcode NULL, barcode_source NULL: pending, never a
 *    `MANUAL-…` placeholder or a `NOBC-…` marker. The bot stores such a
 *    carton since 19/10 (create_pallet_box_inventory: "stored without one");
 *    FEFO, the LPN issue and the Priority push never read the carton
 *    barcode. The page keeps its own keys for the list (a row needs one
 *    while its label is read); only the wire is blanked, server side;
 *  - "create barcode" (a 28… label minted in the edit panel, origin
 *    'receiving') is not offered, and the server refuses it;
 *  - a carton whose own real barcode is on the list but whose weight is
 *    missing opens the edit panel (it starts on the weight) — from its row,
 *    and from New carton while such a carton is waiting.
 */
import { barcodeWeight } from './barcode-weight';
import { isMintedLabelBarcode } from './label-batches';
import { isNoBarcodeId, isProvisionalId } from './no-barcode';
import { isUnitsCarton } from './units-cartons';

/** A code made on this side for a carton with no readable one: `MANUAL-…` or `NOBC-…`. */
export function isHandCode(code: string | null | undefined): boolean {
  const c = (code || '').trim();
  return isProvisionalId(c) || isNoBarcodeId(c);
}

/**
 * The cartons as they are booked: a hand code becomes '' (NULL in
 * box_inventory), and so does a `sku` that is one. Every other row is
 * returned as it is (the same object).
 */
export function pendingBarcodes<T extends { barcode?: string | null; sku?: string | null }>(boxes: T[]): T[] {
  return boxes.map((b) => {
    if (!isHandCode(b.barcode)) return b;
    return { ...b, barcode: '', sku: b.sku && !isHandCode(b.sku) ? b.sku : '' };
  });
}

/** A non-meat sample code as it is booked: '' for a hand code. */
export function pendingSampleBarcode(code: string | null | undefined): string {
  return isHandCode(code) ? '' : (code || '');
}

export interface WeightCheckRow {
  barcode: string;
  weight: number;
  units?: unknown;
  ocr_status?: string;
}

/**
 * A carton the camera read by its own real barcode, whose label gave no
 * weight and whose barcode carries none: the worker types the weight. Not a
 * hand code, not one of our 28… labels, not a units carton (no weight by
 * design), not a read still running or failed (those keep Retry).
 */
export function realCodeMissingWeight(b: WeightCheckRow): boolean {
  const code = (b.barcode || '').trim();
  if (!code || isHandCode(code) || isMintedLabelBarcode(code)) return false;
  if (b.ocr_status === 'processing' || b.ocr_status === 'failed') return false;
  if (isUnitsCarton(b)) return false;
  if (Number(b.weight) > 0) return false;
  return !barcodeWeight(code);
}

/** The first such carton on a list, in list order. */
export function firstRealCodeMissingWeight<T extends WeightCheckRow>(rows: readonly T[]): T | undefined {
  return rows.find(realCodeMissingWeight);
}

/** POST /api/carton-labels: the edit panel's "create barcode" (origin 'receiving') is refused with the flag on. */
export function mintRefused(origin: string, flagOn: boolean): boolean {
  return flagOn && origin === 'receiving';
}
