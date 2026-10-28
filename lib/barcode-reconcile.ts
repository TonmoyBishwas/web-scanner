/**
 * Barcode wins: a carton's weight and expiry follow its 31-digit barcode
 * (client rule, Mevaser 19/10).
 *
 * lib/barcode-parser.ts parseCartonBarcode reads the one format that encodes
 * them — EAN13 (1-13) · 10 g units (14-18) · batch digit (19) · serial
 * (20-23) · DDMMYYYY (24-31); the expiry offsets are wb_barcode_expiry's,
 * behind box_inventory.barcode_expiry (the weight window was one digit too
 * long until 28/10 — lib/barcode-parser.ts). Until now it only
 * raised a yellow "barcode says…" toast, and the booked row kept the OCR. On
 * 19/10 that booked IN264189933's carton …012460129514072027 at 4.38 kg with
 * no expiry (the barcode says 12.460 kg, 14/07/2027) and rounded
 * …013369660304072027 to 13.000 (barcode 13.369), and Priority got the OCR.
 *
 * So: when the barcode carries a plausible value it is the booked value —
 * whether the OCR read nothing or a different number. Except when the two
 * agree (less than 0.01 kg apart, lib/barcode-weight.ts weightsAgree): then
 * the OCR's reading stays, since labels print 5 g / 1 g steps and the code
 * only 10 g (28/10: a 12.385 label under a code of 12.39 is booked 12.385).
 * Nobody is asked; the screen marks the field "from barcode" and a
 * real disagreement is traced to scanner_events. Two guards keep a bad
 * barcode from booking nonsense, both seen in the data:
 *
 *  * an expiry outside received−30 days … received+3 years is not a date the
 *    barcode can mean (IN264184055: `…23082007` = 2007-08-23; the OCR's 2027
 *    was right) → the OCR stays;
 *  * a weight more than 25 % off what the same product weighs on this list,
 *    while the OCR's weight is within it (IN264184063: barcode 9.771 kg, OCR
 *    14.34, the item's other 14 cartons ≈14.5) → the OCR stays.
 *
 * Every other barcode format (25-digit, 16-digit, EAN-13, warehouse labels)
 * carries neither, parses to null, and is left exactly as the OCR read it.
 */

import { parseCartonBarcode } from './barcode-parser';
import { weightsAgree } from './barcode-weight';
import { normalizeExpiry } from './expiry';

/** A barcode expiry this long before the receipt date is not plausible. */
export const BARCODE_EXPIRY_PAST_DAYS = 30;
/** …nor one this far after it. */
export const BARCODE_EXPIRY_FUTURE_YEARS = 3;
/** How far a barcode weight may sit from the product's typical carton. */
export const BARCODE_TYPICAL_BAND = 0.25;
/** OCR and barcode within this share of each other are the same reading. */
export const BARCODE_AGREE_RATIO = 0.05;
/** A weight change at least this big is worth a trace (label rounding is not). */
export const BARCODE_TRACE_KG = 0.05;
/** Cartons of the same product needed before "typical" means anything. */
export const TYPICAL_MIN_SAMPLES = 2;

/** What the field holds came from the barcode; the value is what the OCR had read. */
export interface BarcodeFilled {
  weight?: number | null;
  expiry?: string | null;
}

export interface BarcodeEvent {
  field: 'weight' | 'expiry';
  /** filled = OCR read none · replaced = OCR read another value · kept_ocr = a guard refused the barcode. */
  action: 'filled' | 'replaced' | 'kept_ocr';
  ocr: number | string | null;
  barcode: number | string;
  /** replaced: the gap is over 5 % (weight) — a misread, not rounding. */
  major?: boolean;
  reason?: 'expiry_implausible' | 'weight_outlier';
}

export interface BarcodeReconcile {
  weight: number | null;
  expiry: string | null;
  filled: BarcodeFilled;
  /** Worth a trace: fills, real disagreements and refusals. */
  events: BarcodeEvent[];
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoAddYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** Can a barcode expiry be meant, for a carton received on `receivedIso`? */
export function barcodeExpiryPlausible(expiryIso: string, receivedIso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryIso) || !/^\d{4}-\d{2}-\d{2}$/.test(receivedIso)) return false;
  return expiryIso >= isoAddDays(receivedIso, -BARCODE_EXPIRY_PAST_DAYS)
    && expiryIso <= isoAddYears(receivedIso, BARCODE_EXPIRY_FUTURE_YEARS);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The weight and expiry to book for one carton.
 *
 * `trusted` is false when the code is the OCR's reading of the printed digits
 * (a photo capture) rather than a decoded barcode: one misread digit there
 * moves the weight, so it may only fill a blank, never replace a reading.
 * `typicalKg` is what this product weighs on the list (`typicalWeightFor`).
 */
export function reconcileWithBarcode(
  barcode: string,
  ocr: { weight: number | null | undefined; expiry: string | null | undefined },
  opts: { receivedIso: string; typicalKg?: number | null; trusted?: boolean },
): BarcodeReconcile {
  const ocrWeight = typeof ocr.weight === 'number' && ocr.weight > 0 ? ocr.weight : null;
  const ocrExpiry = normalizeExpiry(ocr.expiry) || null;
  const out: BarcodeReconcile = { weight: ocrWeight, expiry: ocrExpiry, filled: {}, events: [] };
  const parsed = parseCartonBarcode(barcode);
  if (!parsed) return out;
  const trusted = opts.trusted !== false;

  const bw = parsed.weight;
  if (bw !== null && (ocrWeight === null || trusted)) {
    const typical = opts.typicalKg && opts.typicalKg > 0 ? opts.typicalKg : null;
    const near = (x: number) => typical !== null && Math.abs(x - typical) / typical <= BARCODE_TYPICAL_BAND;
    const agree = ocrWeight !== null && Math.abs(bw - ocrWeight) / ocrWeight <= BARCODE_AGREE_RATIO;
    if (ocrWeight !== null && !agree && typical !== null && !near(bw) && near(ocrWeight)) {
      out.events.push({ field: 'weight', action: 'kept_ocr', ocr: ocrWeight, barcode: bw, reason: 'weight_outlier' });
    } else if (ocrWeight === null || !weightsAgree(ocrWeight, bw)) {
      out.weight = bw;
      out.filled.weight = ocrWeight;
      if (ocrWeight === null) {
        out.events.push({ field: 'weight', action: 'filled', ocr: null, barcode: bw });
      } else if (Math.abs(bw - ocrWeight) >= BARCODE_TRACE_KG) {
        out.events.push({ field: 'weight', action: 'replaced', ocr: ocrWeight, barcode: bw, major: !agree });
      }
    }
  }

  const be = parsed.expiry;
  if (be && be !== ocrExpiry && (ocrExpiry === null || trusted)) {
    if (!barcodeExpiryPlausible(be, opts.receivedIso)) {
      out.events.push({ field: 'expiry', action: 'kept_ocr', ocr: ocrExpiry, barcode: be, reason: 'expiry_implausible' });
    } else {
      out.expiry = be;
      out.filled.expiry = ocrExpiry;
      out.events.push({ field: 'expiry', action: ocrExpiry === null ? 'filled' : 'replaced', ocr: ocrExpiry, barcode: be });
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * What this product weighs on the list: the median weight of the OTHER rows
 * with the same 13-digit product prefix. Null with fewer than 2 of them.
 */
export function typicalWeightFor(
  barcode: string,
  rows: ReadonlyArray<{ barcode: string; weight: number }>,
): number | null {
  const prefix = (barcode || '').replace(/\D/g, '').slice(0, 13);
  if (prefix.length < 13) return null;
  const ws = rows
    .filter((r) => r.barcode !== barcode && r.barcode.slice(0, 13) === prefix && r.weight > 0)
    .map((r) => r.weight);
  return ws.length >= TYPICAL_MIN_SAMPLES ? median(ws) : null;
}

export interface BarcodeRow {
  barcode: string;
  weight: number;
  expiry?: string;
  ocr_status?: string;
  captured_via?: 'scan' | 'manual';
  /** The worker saved this carton's weight (edit panel / "weight is correct"). */
  weight_checked?: boolean;
  /** The worker saved this carton's dates in the edit panel. */
  expiry_checked?: boolean;
  barcode_filled?: BarcodeFilled;
}

/**
 * The last pass before a list is booked: every row's weight and expiry
 * follow its barcode, as `reconcileWithBarcode` decides. Catches rows that
 * never went through the OCR hand-off with this rule (a list restored from
 * a cache written before it, a re-read). A value the worker saved himself is
 * his answer and is left alone. Rows that change are new objects; the rest
 * are passed through as the same object.
 */
export function applyBarcodeReadings<R extends BarcodeRow>(
  rows: ReadonlyArray<R>,
  receivedIso: string,
): { rows: R[]; events: Array<BarcodeEvent & { barcode_digits: string }> } {
  const events: Array<BarcodeEvent & { barcode_digits: string }> = [];
  const out = rows.map((r) => {
    if (r.ocr_status && r.ocr_status !== 'done') return r;
    if (!parseCartonBarcode(r.barcode)) return r;
    const typicalKg = typicalWeightFor(r.barcode, rows);
    const trusted = r.captured_via !== 'manual';
    const rec = reconcileWithBarcode(
      r.barcode,
      { weight: r.weight, expiry: r.expiry },
      { receivedIso, typicalKg, trusted },
    );
    let next: R = r;
    // A barcode weight booked at the OCR hand-off, judged again now that the
    // list is whole: on the first carton of a product there was nothing to
    // call it an outlier against. IN264184063's shape read first — barcode
    // 9.771 kg over an OCR 14.34, then 14 more cartons at ≈14.5 — kept 9.771
    // for good, since at confirm the row already agreed with its barcode.
    // The OCR's reading (barcode_filled.weight) goes through the same guard;
    // when it refuses the barcode, the OCR's weight is what is booked.
    const ocrRead = r.barcode_filled?.weight;
    if (!r.weight_checked && typeof ocrRead === 'number' && ocrRead > 0 && ocrRead !== r.weight) {
      const again = reconcileWithBarcode(r.barcode, { weight: ocrRead, expiry: r.expiry }, { receivedIso, typicalKg, trusted });
      const refused = again.events.find((e) => e.field === 'weight' && e.action === 'kept_ocr');
      if (refused) {
        const { weight: _w, ...rest } = r.barcode_filled ?? {};
        next = { ...next, weight: ocrRead, barcode_filled: 'expiry' in rest ? rest : undefined };
        events.push({ ...refused, barcode_digits: r.barcode });
      }
    }
    if (next === r && !r.weight_checked && rec.filled.weight !== undefined && rec.weight !== null && rec.weight !== r.weight) {
      next = { ...next, weight: rec.weight, barcode_filled: { ...next.barcode_filled, weight: rec.filled.weight } };
    }
    if (!r.expiry_checked && rec.filled.expiry !== undefined && rec.expiry !== null && rec.expiry !== normalizeExpiry(r.expiry)) {
      next = { ...next, expiry: rec.expiry, barcode_filled: { ...next.barcode_filled, expiry: rec.filled.expiry } };
    }
    if (next !== r) {
      for (const e of rec.events) {
        // The weight's events belong to the change made: a row reverted to
        // its OCR weight above traced that, not the barcode it had.
        if (e.action === 'kept_ocr' || (e.field === 'weight' && next.weight !== rec.weight)) continue;
        events.push({ ...e, barcode_digits: r.barcode });
      }
    }
    return next;
  });
  return { rows: out, events };
}

/**
 * Does the field still hold the barcode's value? After the worker edits a
 * carton, the "from barcode" marker stays only on a value he left as it was.
 */
export function keepBarcodeFilled(
  barcode: string,
  prev: BarcodeFilled | undefined,
  weight: number,
  expiry: string,
): BarcodeFilled | undefined {
  if (!prev) return undefined;
  const parsed = parseCartonBarcode(barcode);
  const next: BarcodeFilled = {};
  if ('weight' in prev && parsed?.weight != null && round3(weight) === parsed.weight) next.weight = prev.weight;
  if ('expiry' in prev && parsed?.expiry && normalizeExpiry(expiry) === parsed.expiry) next.expiry = prev.expiry;
  return 'weight' in next || 'expiry' in next ? next : undefined;
}
