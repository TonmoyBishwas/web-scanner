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
