/**
 * The net weight a carton's own barcode carries, when it carries one
 * (28/10, Mevaser).
 *
 * Two formats print the carton's weight in the code:
 *
 *  - `glatt25` — מ.ב. גלאט עוף למהדרין (VAT 513749094), one Code128 per carton:
 *        1 · item code (5) · 110010 · net weight in 10 g units (4) · serial (9)
 *    `1050861100101012067935140` = item 05086, 10.12 kg. Checked on 747 past
 *    cartons across every Glatt item: wherever the label OCR disagreed with
 *    the barcode (~110 cartons) the OCR was wrong — 10.15 for labels printing
 *    10.110 / 10.120, 10.93 for 10.090, 120 for 11.99 (lib/weight-sanity.ts)
 *    — and the label photo confirmed the barcode. The 9-digit serial makes
 *    every code unique: two cartons never share one.
 *  - `gs31` — the 31-digit catch-weight code, grams at chars 14–19. Read by
 *    lib/barcode-parser.ts parseCartonBarcode (reused here, not repeated) and
 *    booked through lib/barcode-reconcile.ts with its plausibility guards.
 *
 * Every other code (EAN-13 per-product codes like 7290020497000, other
 * 25-digit formats, our own `28…` labels, a misread of another length)
 * carries no weight and returns null.
 */

import { parseCartonBarcode } from './barcode-parser';

export type BarcodeWeightSource = 'glatt25' | 'gs31';

export interface BarcodeWeight {
  kg: number;
  /** glatt25: the supplier's 5-digit item code (e.g. `05086`). */
  itemCode?: string;
  source: BarcodeWeightSource;
}

const GLATT25 = /^1(\d{5})110010(\d{4})(\d{9})$/;
/** Outside this band the code is not a carton weight we trust. */
export const GLATT_MIN_KG = 0.5;
export const GLATT_MAX_KG = 60;

/** Barcode and OCR this close are the same reading (float noise, not a band). */
export const BARCODE_WEIGHT_AGREE_KG = 0.01;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function parseGlatt25(code: string): BarcodeWeight | null {
  const m = GLATT25.exec(code);
  if (!m) return null;
  const kg = Number(m[2]) / 100;
  if (!Number.isFinite(kg) || kg < GLATT_MIN_KG || kg > GLATT_MAX_KG) return null;
  return { kg: round3(kg), itemCode: m[1], source: 'glatt25' };
}

export function barcodeWeight(barcode: string | null | undefined): BarcodeWeight | null {
  const code = (barcode || '').trim();
  if (!/^\d+$/.test(code)) return null;
  const glatt = parseGlatt25(code);
  if (glatt) return glatt;
  const w = parseCartonBarcode(code)?.weight ?? null;
  return w !== null ? { kg: w, source: 'gs31' } : null;
}

/** Does this carton's barcode carry its own weight? Such a carton is never
 *  "identical" to another one — its weight is its own. */
export function barcodeCarriesWeight(barcode: string | null | undefined): boolean {
  return barcodeWeight(barcode) !== null;
}

/** Two weights differ by more than float noise / the 10 g the codes print. */
export function weightsDisagree(a: number, b: number): boolean {
  return Math.abs(a - b) > BARCODE_WEIGHT_AGREE_KG + 1e-9;
}

export interface BarcodeWeightOverride {
  barcode: string;
  ocr_kg: number | null;
  barcode_kg: number;
  source: BarcodeWeightSource;
  item_code?: string;
}

/**
 * POST /api/multi-pallet-ocr: the weight to hand back for a decoded barcode
 * and the label OCR's reading. A Glatt 25-digit code's weight is what the
 * carton weighs, so it replaces the OCR's (or fills a blank one). `event` is
 * set when that changed a reading by more than 0.01 kg, or filled a blank —
 * worth a `weight_barcode_override` trace.
 *
 * Only glatt25 here: a 31-digit code's weight is settled on the page
 * (lib/barcode-reconcile.ts), whose guards need the OCR's own reading
 * (IN264184063: a 31-digit code said 9.771 kg, the carton weighed 14.34).
 * Overriding it here would hide that reading from them.
 */
export function ocrWeightFromBarcode(
  barcode: string | null | undefined,
  ocrKg: unknown,
): { weight_kg: number; event: BarcodeWeightOverride | null } | null {
  const bw = barcodeWeight(barcode);
  if (!bw || bw.source !== 'glatt25') return null;
  const n = typeof ocrKg === 'string' ? parseFloat(ocrKg) : ocrKg;
  const ocr = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  const changed = ocr === null || weightsDisagree(ocr, bw.kg);
  return {
    weight_kg: bw.kg,
    event: changed
      ? { barcode: (barcode || '').trim(), ocr_kg: ocr, barcode_kg: bw.kg, source: bw.source, item_code: bw.itemCode }
      : null,
  };
}
