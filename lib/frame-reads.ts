/**
 * One frame, two barcodes: the carton's own code over the product code.
 *
 * Some cartons carry two stickers side by side. Well Done 48288 (David,
 * 2026-10-11): a black brand sticker with a plain EAN-13 `7290008432467` —
 * the invoice item code, identical on every carton — and a white Sokołów
 * label with a 30-digit carton code that ends in the carton's own net weight.
 * Both decode in the same frame. The read confirmer counts each value on its
 * own and the first to reach two identical reads wins, so the EAN-13 often
 * won: the carton was booked under the product code, the OCR then read the
 * brand sticker (a piece count for a weight, a production date for an
 * expiry), and every later carton was "already counted".
 *
 * Rule: when ONE frame holds both a product code (13 digits or fewer) and a
 * carton code (15+ digits that `classifyRead` accepts — a GS1-128 or a
 * warehouse `28…` label), the product codes are dropped from that frame.
 * Everything else passes as it came:
 *  * a frame with only an EAN-13 (kabanos, fixed-weight goods) is untouched;
 *  * the supplier's shipping-pallet label (`1000000000…`, MEV-10) is never a
 *    carton code, so it never causes a drop — and it is not dropped either:
 *    the page still recognises and refuses it as today;
 *  * a GTIN-14 and anything that is not all digits (an LPN QR) stay.
 *
 * Engine-agnostic: works on the `FrameRead`s any decoder produces.
 */

import type { FrameRead } from './barcode-frame';
import { classifyRead, isSupplierPalletLabel } from './carton-barcode';

/** A product code: all digits, 13 or fewer (EAN-8 / UPC-A / EAN-13). */
export function isProductCode(value: string): boolean {
  return /^\d{1,13}$/.test(value);
}

/** A carton code: 15+ digits, not the supplier's pallet label, a read the page would accept. */
export function isCartonCode(value: string): boolean {
  if (!/^\d{15,}$/.test(value)) return false;
  if (isSupplierPalletLabel(value)) return false;
  return classifyRead(value).ok;
}

/**
 * A frame's reads with the product codes dropped when a carton code shares
 * the frame. Returns the same array when nothing is dropped.
 */
export function preferCartonCodes<T extends FrameRead>(reads: T[]): T[] {
  if (reads.length < 2) return reads;
  if (!reads.some((r) => isCartonCode(r.value))) return reads;
  if (!reads.some((r) => isProductCode(r.value))) return reads;
  return reads.filter((r) => !isProductCode(r.value));
}
