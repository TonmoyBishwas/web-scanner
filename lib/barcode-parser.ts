import type { ParsedBarcode } from '@/types';

/**
 * Parses Israeli meat label barcodes in GS1-128 format.
 *
 * Standard format (Brown Box, >28 digits):
 * - SKU: positions 0-13 (13 digits)
 * - Data: positions 13-19 (6 digits)
 * - Weight: positions 19-25 (6 digits, in grams)
 * - Expiry: positions 25-31 (6 digits, DDMMYY)
 *
 * Variable format (White Label, 24-28 digits):
 * - SKU: positions 0-13 (13 digits)
 * - Weight: positions 12-18 or 13-19 (6 digits, in grams)
 * - Expiry: last 6 digits (DDMMYY)
 *
 * @param barcodeString - The raw barcode string to parse
 * @returns ParsedBarcode object or null if parsing fails
 */
export function parseIsraeliBarcode(barcodeString: string): ParsedBarcode | null {
  if (!barcodeString) {
    return null;
  }

  // Clean barcode - remove all non-digit characters
  const clean = barcodeString.replace(/\D/g, '');
  const length = clean.length;

  // Minimum length check
  if (length < 24) {
    return null;
  }

  try {
    // Case A: Brown Box (Standard format, >28 digits)
    if (length > 28) {
      return parseStandardFormat(clean, barcodeString);
    }

    // Case B: White Label (Variable format, 24-28 digits)
    if (length >= 24 && length <= 28) {
      return parseVariableFormat(clean, barcodeString);
    }

    // Case C: OCR noise from brown box (29-31 digits with noise)
    if (length >= 29 && length <= 31) {
      // Try using last 25 digits as white label format
      const cleanWhite = clean.slice(-25);
      const whiteResult = parseVariableFormat(cleanWhite, barcodeString);
      if (whiteResult) {
        return whiteResult;
      }
      // Fallback to standard format with first 31 digits
      return parseStandardFormat(clean.slice(0, 31), barcodeString);
    }

    return null;
  } catch (error) {
    console.error('Error parsing barcode:', error);
    return null;
  }
}

/**
 * Parse Standard format (Brown Box)
 * Format: SKU[0:13] + DATA[13:19] + WEIGHT[19:25] + EXPIRY[25:31]
 */
function parseStandardFormat(clean: string, rawBarcode: string): ParsedBarcode | null {
  if (clean.length < 31) {
    return null;
  }

  const sku = clean.substring(0, 13);
  const weightGrams = parseInt(clean.substring(19, 25), 10);
  const expiry = clean.substring(25, 31);

  // Validate weight
  if (isNaN(weightGrams) || weightGrams <= 0) {
    return null;
  }

  const weight = weightGrams / 1000; // Convert to KG

  return {
    type: 'Standard',
    sku,
    weight,
    expiry,
    raw_barcode: rawBarcode
  };
}

/**
 * Parse Variable format (White Label)
 * Format: SKU[0:13] + WEIGHT[12:18 or 13:19] + EXPIRY[-6:]
 *
 * Uses heuristic to determine correct weight position:
 * - Position B (12-18) is preferred if weight is 5-40kg
 * - Otherwise uses Position A (13-19)
 */
function parseVariableFormat(clean: string, rawBarcode: string): ParsedBarcode | null {
  // Normalize to 25 characters if needed
  let normalized = clean;
  if (clean.length < 25) {
    normalized = clean.padEnd(25, '0');
  } else if (clean.length > 25) {
    normalized = clean.slice(-25);
  }

  const sku = normalized.substring(0, 13);

  // Two possible weight positions
  const weightAGrams = parseInt(normalized.substring(13, 19), 10);
  const weightBGrams = parseInt(normalized.substring(12, 18), 10);

  // Validate weights
  const weightA = isNaN(weightAGrams) ? 0 : weightAGrams / 1000;
  const weightB = isNaN(weightBGrams) ? 0 : weightBGrams / 1000;

  // Heuristic: Prefer B if it's in valid range (5-40kg), otherwise use A
  let finalWeight = weightA;
  if (weightB >= 5.0 && weightB <= 40.0) {
    finalWeight = weightB;
  }

  // Expiry is always last 6 digits
  const expiry = normalized.slice(-6);

  return {
    type: 'Variable',
    sku,
    weight: finalWeight,
    expiry,
    raw_barcode: rawBarcode
  };
}

/**
 * Format expiry date from DDMMYY to a more readable format
 */
export function formatExpiry(expiry: string): string {
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
 * Validate if a barcode string matches expected format
 */
export function isValidBarcodeFormat(barcodeString: string): boolean {
  const clean = barcodeString.replace(/\D/g, '');
  const length = clean.length;
  return length >= 24 && length <= 35;
}

/**
 * Extract GTIN from barcode (first 13 or 14 digits)
 */
export function extractGTIN(barcodeString: string): string | null {
  const clean = barcodeString.replace(/\D/g, '');
  if (clean.length >= 13) {
    return clean.substring(0, 13);
  }
  return null;
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
