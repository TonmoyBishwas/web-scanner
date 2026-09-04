import type { ParsedBarcode } from '@/types';

/**
 * Parses barcodes as identifiers ONLY.
 *
 * NEW PHILOSOPHY: Barcodes are just IDs.
 * All box data (weight, expiry, product info) comes from OCR or manual entry.
 *
 * This function no longer parses weight, expiry, or any other data from barcodes.
 * It simply returns the barcode as a unique identifier.
 *
 * @param barcodeString - The raw barcode string to parse
 * @returns ParsedBarcode object with barcode as ID only
 */
export function parseIsraeliBarcode(barcodeString: string): ParsedBarcode | null {
  if (!barcodeString) {
    return null;
  }

  // Clean barcode - remove all non-digit characters for the SKU
  const clean = barcodeString.replace(/\D/g, '');

  // Barcodes are now JUST identifiers
  // All meaningful data (weight, expiry, product info) MUST come from OCR or manual entry
  return {
    type: 'id-only',
    sku: clean,       // Just the ID
    weight: 0,        // From OCR only
    expiry: '',       // From OCR only
    raw_barcode: barcodeString,
    expiry_source: 'ocr_required'
  };
}

/**
 * Format expiry date from 8-digit DDMMYYYY to DD/MM/YYYY
 * Example: 29072026 -> 29/07/2026
 * KEPT FOR OCR PROCESSING COMPATIBILITY
 */
export function formatExpiry8Digit(expiry: string): string {
  if (!expiry || expiry.length !== 8) {
    return expiry;
  }

  const day = expiry.substring(0, 2);
  const month = expiry.substring(2, 4);
  const year = expiry.substring(4, 8);

  return `${day}/${month}/${year}`;
}

/**
 * Format expiry date from 6-digit DDMMYY to DD/MM/YYYY
 * Example: 290726 -> 29/07/2026
 * Assumes years 00-99 are 2000-2099
 * KEPT FOR OCR PROCESSING COMPATIBILITY
 */
export function formatExpiry6Digit(expiry: string): string {
  if (!expiry || expiry.length !== 6) {
    return expiry;
  }

  const day = expiry.substring(0, 2);
  const month = expiry.substring(2, 4);
  const year = expiry.substring(4, 6);

  // Determine century (assuming 2000-2099)
  const fullYear = `20${year}`;

  return `${day}/${month}/${fullYear}`;
}

/**
 * Format expiry date from either 6 or 8 digit format
 * KEPT FOR OCR PROCESSING COMPATIBILITY
 */
export function formatExpiry(expiry: string): string {
  if (!expiry) {
    return '';
  }

  if (expiry.length === 8) {
    return formatExpiry8Digit(expiry);
  }

  if (expiry.length === 6) {
    return formatExpiry6Digit(expiry);
  }

  return expiry;
}

/**
 * Validate if a barcode string is non-empty
 * Relaxed validation - any non-empty string is valid as an ID
 */
export function isValidBarcodeFormat(barcodeString: string): boolean {
  const clean = barcodeString.replace(/\D/g, '');
  return clean.length >= 1;  // Any length is valid for ID-only approach
}

/**
 * Extract GTIN/SKU from barcode (returns cleaned barcode)
 */
export function extractGTIN(barcodeString: string): string | null {
  const clean = barcodeString.replace(/\D/g, '');
  return clean.length > 0 ? clean : null;
}

/**
 * Check if barcode is duplicate
 */
export function isDuplicateBarcode(
  barcode: string,
  scannedBarcodes: Map<string, ParsedBarcode>
): boolean {
  return scannedBarcodes.has(barcode);
}

/**
 * Get barcode type description for UI display
 */
export function getBarcodeTypeDescription(type: ParsedBarcode['type']): string {
  switch (type) {
    case 'id-only':
      return 'ID (OCR for data)';
    case '31-digit':
      return 'All-in-One (31-digit)';
    case '25-digit':
      return 'Jerusalem Poultry (25-digit)';
    case 'short':
      return 'Short/EAN-13';
    case 'unknown':
      return 'Unknown Format';
    default:
      return 'Unknown';
  }
}

/**
 * Check if expiry needs to be obtained from OCR
 * ALWAYS TRUE in the new system
 */
export function needsOcrForExpiry(parsedBarcode: ParsedBarcode | null): boolean {
  return true;  // All data must come from OCR or manual entry
}

/**
 * Check if weight needs to be obtained from OCR
 * ALWAYS TRUE in the new system
 */
export function needsOcrForWeight(parsedBarcode: ParsedBarcode | null): boolean {
  return true;  // All data must come from OCR or manual entry
}

// ─── 31-digit carton barcodes: a deterministic cross-check, never a source ───
//
// The rule above ("barcodes are IDs only") is correct for the 25-digit format,
// which is 62 % of cartons and carries nothing at all. It is NOT correct for
// the 31-digit format. Measured against all 264 live box_inventory rows on
// 2026-09-04, and reproduced independently by the Priority side:
//
//   1-13   EAN13
//   14-19  weight in grams    → 65/67 within 20 g of the OCR weight
//   20-23  per-carton serial  → unique per carton; NOT a supplier batch
//   24-31  expiry DDMMYYYY    → 67/67 valid, 64 agree with the OCR
//
// In all three expiry disagreements the barcode was right and the OCR had
// misread a digit. That still does not make it authoritative: a parser that
// speaks for a quarter of cartons and is silent for the rest is one supplier
// label change away from booking a wrong weight. So this is only ever used to
// FLAG a disagreement for the worker while they are still holding the carton.
// Mirrored server-side by wb_barcode_expiry / wb_barcode_weight_kg, which feed
// the generated columns box_inventory.barcode_expiry / .barcode_weight_kg.

export interface CartonBarcodeData {
  /** kg, or null when this barcode format carries no weight. */
  weight: number | null;
  /** ISO `YYYY-MM-DD`, or null. */
  expiry: string | null;
}

export function parseCartonBarcode(barcodeString: string): CartonBarcodeData | null {
  const digits = (barcodeString || '').replace(/\D/g, '');
  if (digits.length !== 31) return null;   // only the one format we measured

  let weight: number | null = Number(digits.slice(13, 19)) / 1000;
  // Outside this band the offset does not hold for that supplier's stock —
  // say nothing rather than something wrong.
  if (!Number.isFinite(weight) || weight <= 0.5 || weight > 100) weight = null;
  else weight = Math.round(weight * 1000) / 1000;

  let expiry: string | null = null;
  const tail = digits.slice(23, 31);
  const dd = Number(tail.slice(0, 2));
  const mm = Number(tail.slice(2, 4));
  const yyyy = Number(tail.slice(4, 8));
  if (yyyy >= 2020 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    // Rejects 31/02 and friends, which Date would silently roll into March.
    if (d.getUTCFullYear() === yyyy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd) {
      expiry = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  return weight === null && expiry === null ? null : { weight, expiry };
}

/** Weight gap that counts as a real disagreement rather than label rounding. */
export const BARCODE_WEIGHT_TOLERANCE_KG = 0.05;

export interface BarcodeConflict {
  weight?: { barcode: number; ocr: number };
  expiry?: { barcode: string; ocr: string };
}

/**
 * Compare a 31-digit barcode against what the OCR read off the same sticker.
 * Returns null when they agree, when the format carries nothing, or when the
 * OCR gave us nothing to compare against (a blank is a separate problem —
 * `needs_review` already covers it, and filling it from the barcode is exactly
 * the authoritative behaviour we are avoiding).
 */
export function findBarcodeConflict(
  barcodeString: string,
  ocrWeightKg: number | null | undefined,
  ocrExpiryIso: string | null | undefined,
): BarcodeConflict | null {
  const parsed = parseCartonBarcode(barcodeString);
  if (!parsed) return null;

  const out: BarcodeConflict = {};
  if (parsed.weight !== null && typeof ocrWeightKg === 'number' && ocrWeightKg > 0
      && Math.abs(parsed.weight - ocrWeightKg) >= BARCODE_WEIGHT_TOLERANCE_KG) {
    out.weight = { barcode: parsed.weight, ocr: ocrWeightKg };
  }
  if (parsed.expiry && ocrExpiryIso && parsed.expiry !== ocrExpiryIso) {
    out.expiry = { barcode: parsed.expiry, ocr: ocrExpiryIso };
  }
  return out.weight || out.expiry ? out : null;
}
