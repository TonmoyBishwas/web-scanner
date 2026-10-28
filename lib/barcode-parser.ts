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

// ─── 31-digit carton barcodes: the weight and expiry they carry ───
//
// The rule above ("barcodes are IDs only") is correct for the 25-digit format,
// which is most cartons and carries nothing at all. It is NOT correct for
// the 31-digit format. Measured against all 264 live box_inventory rows on
// 2026-09-04, and reproduced independently by the Priority side:
//
//   1-13   EAN13
//   14-18  weight in 10 g     → see the 28/10 correction below
//   19     per-batch digit    → the same on every carton of a batch; NOT grams
//   20-23  per-carton serial  → unique per carton; NOT a supplier batch
//   24-31  expiry DDMMYYYY    → 67/67 valid, 64 agree with the OCR
//
// 28/10 correction: the weight was read as grams at chars 14–19 until now,
// one digit too long. Char 19 is constant per batch on every batch with 5+
// cartons (Landa 09092027: `5` on all 41; 7290003670444 27062027: `9` on all
// 21), and a label photo prints 14.080 over `7290115351484|01408|5|4563|…`.
// Chars 14–18 ÷ 100 match 295/354 pre-19/10 cartons exactly; the old window
// matched 132 and booked 15.674 for labels printing 15.67 (25/10). Same
// window in the bot (bot/utils/carton_barcode.py) and in SQL
// (carton_barcode_weight_kg); test/fixtures/barcode_weight_fixture.json is
// the shared case list.
//
// A leading `]C1` is a scanner's AIM symbology identifier (GS1-128), not part
// of the code: it is stripped first (one July carton was stored with it).
//
// In all three expiry disagreements the barcode was right and the OCR had
// misread a digit; by 19/10 (424 cartons, 16 products) that held, bar two odd
// ones the guards cover. The
// client's rule since 19/10: the barcode WINS — when the OCR read nothing or
// something else, the booked value is the barcode's (lib/barcode-reconcile.ts,
// with its plausibility guards). Same expiry offsets as wb_barcode_expiry,
// which feeds the generated column box_inventory.barcode_expiry; this side
// also refuses a year outside 2020-2099 (IN264184055's `…23082007`), the
// database does not. (wb_barcode_weight_kg behind .barcode_weight_kg still
// reads the old 14–19 grams window and is left as it is.)

export interface CartonBarcodeData {
  /** kg, or null when this barcode format carries no weight. */
  weight: number | null;
  /** ISO `YYYY-MM-DD`, or null. */
  expiry: string | null;
}

/** The AIM symbology identifier a scanner may prefix to a GS1-128 read. */
const AIM_GS1_128 = ']C1';

/** The code without a leading `]C1` (AIM identifier), trimmed. */
export function stripAimPrefix(code: string | null | undefined): string {
  const c = (code || '').trim();
  return c.startsWith(AIM_GS1_128) ? c.slice(AIM_GS1_128.length) : c;
}

/** Outside this band (kg, lower bound exclusive) a 31-digit weight is not one we trust. */
export const GS31_MIN_KG = 0.5;
export const GS31_MAX_KG = 100;

export function parseCartonBarcode(barcodeString: string): CartonBarcodeData | null {
  const digits = stripAimPrefix(barcodeString);
  if (!/^\d{31}$/.test(digits)) return null;   // only the one format we measured

  let weight: number | null = Number(digits.slice(13, 18)) / 100;
  // Outside this band the offset does not hold for that supplier's stock —
  // say nothing rather than something wrong.
  if (!Number.isFinite(weight) || weight <= GS31_MIN_KG || weight > GS31_MAX_KG) weight = null;
  else weight = Math.round(weight * 100) / 100;

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
