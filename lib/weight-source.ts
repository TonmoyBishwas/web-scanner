/**
 * Where a carton's WEIGHT came from (04/11, items 9/10 of the client's list;
 * Mevaser 02/11). `barcode_source` (lib/barcode-provenance.ts) says how the
 * BARCODE was captured, and its 'minted' covers a typed New carton, a
 * one-tap twin and an "all identical" copy alike; this tells them apart.
 *
 * Sent to the bot on every carton of pallet-complete and
 * loose-boxes-complete as `weight_source`, for box_inventory.weight_source
 * (the bot stores it only once its column exists, and overrides it with
 * 'label_barcode' when the carton's own barcode confirms the weight). Pure;
 * nothing here is shown to the worker.
 *
 *  - `units`          — a units carton: no weight by design;
 *  - `typed`          — keyed in by the worker: New carton, an edit-panel
 *                       weight he changed, a copy whose form weight he
 *                       changed, or a copy of a carton whose weight was typed
 *                       or unknown;
 *  - `twin_copy` / `identical_copy` — a one-tap twin / "all identical" copy
 *                       of a carton whose label was read;
 *  - `label_barcode`  — the carton's own barcode weight (31-digit / Glatt),
 *                       or a figure it confirms within 0.011 kg;
 *  - `label_ocr`      — the label reading, as read;
 *  - `note_avg`       — set by the route itself for damaged-sticker samples;
 *  - `unknown`        — nothing tells.
 */
import { barcodeWeight } from './barcode-weight';

export type WeightSource =
  | 'label_ocr' | 'label_barcode' | 'typed' | 'twin_copy' | 'identical_copy'
  | 'note_avg' | 'units' | 'unknown';

export const WEIGHT_SOURCES: readonly WeightSource[] = [
  'label_ocr', 'label_barcode', 'typed', 'twin_copy', 'identical_copy', 'note_avg', 'units', 'unknown',
];

/** A typed figure within this of the barcode's own weight is the barcode's (its 10 g step + float noise). */
export const WEIGHT_SOURCE_BARCODE_AGREE_KG = 0.011;
/** The label reading kept as read: less than this from it. */
export const WEIGHT_SOURCE_OCR_AGREE_KG = 0.01;

export interface WeightSourceRow {
  barcode: string;
  weight: number;
  units?: number;
  new_carton?: boolean;
  minted?: boolean;
  twin?: boolean;
  /** The worker changed the weight (edit panel, or the copy form vs its sample). */
  weight_typed?: boolean;
  /** A copy: the weight source of the carton it was copied from. */
  weight_copied_from?: WeightSource;
  /** lib/barcode-reconcile.ts: the fields now holding the barcode's value. */
  barcode_filled?: unknown;
  /** The sticker OCR's own weight reading, before any override. */
  ocr_weight?: number | null;
}

/** A weight the worker changed: 1 g or more apart (float noise aside: 10.106 − 10.105 is 0.00099…). */
export function weightChanged(next: number, prev: number): boolean {
  return Number.isFinite(next) && Number.isFinite(prev) && Math.abs(next - prev) >= 0.001 - 1e-9;
}

function barcodeBacked(row: WeightSourceRow): boolean {
  const kg = barcodeWeight(row.barcode)?.kg;
  const w = Number(row.weight);
  return kg !== undefined && Number.isFinite(w) && w > 0
    && Math.abs(w - kg) <= WEIGHT_SOURCE_BARCODE_AGREE_KG;
}

function filledFromBarcode(row: WeightSourceRow): boolean {
  const f = row.barcode_filled;
  return !!f && typeof f === 'object' && 'weight' in (f as object);
}

export function weightSourceOf(row: WeightSourceRow): WeightSource {
  if ((Number(row.units) || 0) > 0) return 'units';
  // New carton: its rows also go through expandIdenticalBoxes (as minted
  // copies of an empty sample), so this comes before the copy rule.
  if (row.new_carton) return 'typed';
  if (row.minted || row.twin) {
    if (barcodeBacked(row)) return 'label_barcode';
    const from = row.weight_copied_from;
    // A weight with no label behind it, copied: still the worker's figure.
    if (row.weight_typed || from === 'typed' || from === 'unknown') return 'typed';
    // A copy cached before 04/11 carries no source: never claimed label-backed.
    if (!from) return 'unknown';
    return row.twin ? 'twin_copy' : 'identical_copy';
  }
  if (row.weight_typed) return barcodeBacked(row) ? 'label_barcode' : 'typed';
  if (filledFromBarcode(row) || barcodeBacked(row)) return 'label_barcode';
  const ocr = Number(row.ocr_weight);
  const w = Number(row.weight);
  if (ocr > 0 && Number.isFinite(w) && Math.abs(w - ocr) < WEIGHT_SOURCE_OCR_AGREE_KG) return 'label_ocr';
  return 'unknown';
}
