/**
 * The net weight a carton's own barcode carries, when it carries one
 * (28/10, Mevaser).
 *
 * Two formats print the carton's weight in the code:
 *
 *  - `glatt25` — מ.ב. גלאט עוף למהדרין (VAT 513749094), one Code128 per carton:
 *        1 · item code (5) · mid (6) · net weight in 10 g units (4) · serial (9)
 *    `1050861100101012067935140` = item 05086, 10.12 kg. Mid `110010` on 747
 *    cartons; `010010` (turkey roulade 02353, 5/5 agree) and `110610` (1/1)
 *    carry the weight the same way. `140010` is a units item (04304, the
 *    label says "11 יחידות", weight field `0001`): no weight. Any other mid
 *    was a decoder misread (`1050861153020…` for a printed `…110010 1012…`,
 *    `1014821100022…` for `…110010 1733…`): no weight. Checked on 747 past
 *    cartons across every Glatt item: wherever the label OCR disagreed with
 *    the barcode (~110 cartons) the OCR was wrong — 10.15 for labels printing
 *    10.110 / 10.120, 10.93 for 10.090, 120 for 11.99 (lib/weight-sanity.ts)
 *    — and the label photo confirmed the barcode. The 9-digit serial makes
 *    every code unique: two cartons never share one.
 *  - `gs31` — the 31-digit catch-weight code (a leading `]C1` stripped),
 *    10 g units at chars 14–18; char 19 is a per-batch digit, not grams
 *    (28/10). Read by lib/barcode-parser.ts parseCartonBarcode (reused here,
 *    not repeated) and booked through lib/barcode-reconcile.ts with its
 *    plausibility guards.
 *
 * The same rules live in the bot (bot/utils/carton_barcode.py) and in SQL
 * (carton_barcode_weight_kg / carton_weight_formats); every side runs the
 * shared case list test/fixtures/barcode_weight_fixture.json.
 *
 * Barcode and OCR agree when they are less than 0.01 kg apart. Then the OCR's
 * reading is booked, not the barcode's: labels print 5 g / 1 g steps, the
 * codes only 10 g (25/10: 40 drumstick labels said 15.67, the code's old
 * grams window booked 15.674).
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

const GLATT25 = /^1(\d{5})(110010|010010|110610)(\d{4})(\d{9})$/;
/** Outside this band (kg, lower bound exclusive, as the bot) the code is not a carton weight we trust. */
export const GLATT_MIN_KG = 0.5;
export const GLATT_MAX_KG = 60;

/** Barcode and OCR less than this apart are the same reading (the code's 10 g step). */
export const BARCODE_WEIGHT_AGREE_KG = 0.01;
/** Float noise: 10.11 − 10.1 is 0.00999…, which is 10 g, not less. */
const FLOAT_EPS = 1e-9;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function parseGlatt25(code: string): BarcodeWeight | null {
  const m = GLATT25.exec(code);
  if (!m) return null;
  const kg = Number(m[3]) / 100;
  if (!Number.isFinite(kg) || kg <= GLATT_MIN_KG || kg > GLATT_MAX_KG) return null;
  return { kg: round3(kg), itemCode: m[1], source: 'glatt25' };
}

export function barcodeWeight(barcode: string | null | undefined): BarcodeWeight | null {
  const code = (barcode || '').trim();
  const glatt = parseGlatt25(code);
  if (glatt) return glatt;
  // parseCartonBarcode strips a leading `]C1` and wants exactly 31 digits.
  const w = parseCartonBarcode(code)?.weight ?? null;
  return w !== null ? { kg: w, source: 'gs31' } : null;
}

/** Does this carton's barcode carry its own weight? Such a carton is never
 *  "identical" to another one — its weight is its own. */
export function barcodeCarriesWeight(barcode: string | null | undefined): boolean {
  return barcodeWeight(barcode) !== null;
}

/** The same reading: less than 0.01 kg apart (exactly 0.01 is a 10 g difference). */
export function weightsAgree(a: number, b: number): boolean {
  return Math.abs(a - b) < BARCODE_WEIGHT_AGREE_KG - FLOAT_EPS;
}

/** Two weights 0.01 kg or more apart — a real difference, not the label's rounding. */
export function weightsDisagree(a: number, b: number): boolean {
  return !weightsAgree(a, b);
}

/**
 * The OCR's own weight reading: a positive number, else null. What
 * /api/multi-pallet-ocr returns as `ocr_weight_kg` (before any barcode
 * override), the row keeps as `ocr_weight` and the bot stores in
 * box_inventory.ocr_weight_kg, for the barcode-vs-OCR weight check.
 */
export function rawOcrWeightKg(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
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
 * carton weighs, so it replaces the OCR's (or fills a blank one) — unless the
 * two agree (less than 0.01 kg apart), when the OCR's finer reading stays.
 * `event` is set when the barcode changed a reading (0.01 kg or more), or
 * filled a blank — worth a `weight_barcode_override` trace.
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
  const ocr = rawOcrWeightKg(ocrKg);
  if (ocr !== null && weightsAgree(ocr, bw.kg)) return { weight_kg: ocr, event: null };
  return {
    weight_kg: bw.kg,
    event: { barcode: (barcode || '').trim(), ocr_kg: ocr, barcode_kg: bw.kg, source: bw.source, item_code: bw.itemCode },
  };
}
