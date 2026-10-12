/**
 * Two barcodes on one carton: the carton's own code over the product code.
 *
 * Some cartons carry two stickers side by side. Well Done 48288 (David,
 * 2026-10-11): a black brand sticker with a plain EAN-13 `7290008432467` —
 * the invoice item code, identical on every carton — and a white Sokołów
 * label with a 30-digit carton code that ends in the carton's own net weight.
 * The read confirmer counts each value on its own and the first to reach two
 * identical reads wins, so the EAN-13 often won: the carton was booked under
 * the product code, the OCR then read the brand sticker (a piece count for a
 * weight, a production date for an expiry), and every later carton was
 * "already counted".
 *
 * Rule: a short code (13 digits or fewer: an EAN-13, or a fragment of a
 * longer code) is dropped only when it BELONGS TO a carton code seen in the
 * same moment — the carton code (15+ digits that `classifyRead` accepts)
 * carries it:
 *  * contains the short code whole (Tapaz/Baladi: the 31-digit code starts
 *    with its GTIN-13; a 6-digit fragment `020926` read off the middle of the
 *    Sokołów code), or
 *  * contains an EAN-13's item reference — the digits after the 3-digit GS1
 *    prefix, leading zeros stripped (Sokołów `388432467…` holds `8432467` of
 *    `7290008432467`).
 * A product code that belongs to no carton code in view is KEPT: on a mixed
 * pallet the centred kabanos EAN-13 must not lose to a neighbour's 31-digit
 * sticker at the edge of the strip — the confirmer's nearest-the-centre rule
 * decides between unrelated codes, as it always has.
 *
 * Everything else passes as it came:
 *  * a frame with only an EAN-13 (kabanos, fixed-weight goods) is untouched;
 *  * the supplier's shipping-pallet label (`1000000000…`, MEV-10) is never a
 *    carton code, so it never causes a drop — and it is not dropped either:
 *    the page still recognises and refuses it as today;
 *  * a GTIN-14 and anything that is not all digits (an LPN QR) stay.
 *
 * "Same moment" spans decoder engines: the platform detector and the
 * edge-to-edge Code 128 worker hand their reads over separately for the same
 * camera frame (on the Well Done carton the long code was only ever read by
 * the worker, the EAN-13 only by the detector), so `CartonCodeMemory`
 * remembers carton codes for the confirmer's 3 s window.
 *
 * Engine-agnostic: works on the `FrameRead`s any decoder produces.
 */

import type { FrameRead } from './barcode-frame';
import { classifyRead, isSupplierPalletLabel } from './carton-barcode';

/** A short code: all digits, 13 or fewer (EAN-8 / UPC-A / EAN-13, or a fragment). */
export function isProductCode(value: string): boolean {
  return /^\d{1,13}$/.test(value);
}

/** A carton code: 15+ digits, not the supplier's pallet label, a read the page would accept. */
export function isCartonCode(value: string): boolean {
  if (!/^\d{15,}$/.test(value)) return false;
  if (isSupplierPalletLabel(value)) return false;
  return classifyRead(value).ok;
}

/** Shorter than this, a substring match could be chance. */
const MIN_MATCH_DIGITS = 6;

/**
 * Does the carton code `carton` carry the short code `code` — whole, or (for
 * an EAN-13) its item reference? Then both are on the same carton.
 */
export function belongsToCartonCode(code: string, carton: string): boolean {
  if (!isProductCode(code) || !isCartonCode(carton)) return false;
  if (code.length >= MIN_MATCH_DIGITS && carton.includes(code)) return true;
  if (code.length === 13) {
    const itemRef = code.slice(3).replace(/^0+/, '');
    if (itemRef.length >= MIN_MATCH_DIGITS && carton.includes(itemRef)) return true;
  }
  return false;
}

/**
 * One frame's reads with every short code that belongs to a carton code in
 * the same frame dropped. Returns the same array when nothing is dropped.
 */
export function preferCartonCodes<T extends FrameRead>(reads: T[]): T[] {
  if (reads.length < 2) return reads;
  const cartons = reads.map((r) => r.value).filter(isCartonCode);
  if (cartons.length === 0) return reads;
  const out = reads.filter((r) => !cartons.some((c) => belongsToCartonCode(r.value, c)));
  return out.length === reads.length ? reads : out;
}

/** How long a carton code read by one engine still claims its product code: the confirmer's window. */
export const CARTON_CODE_MEMORY_MS = 3000;

/**
 * `preferCartonCodes` across calls: carton codes seen in the last `windowMs`
 * (from any engine) still claim their product codes and fragments.
 */
export class CartonCodeMemory {
  private seen = new Map<string, number>();

  constructor(private readonly windowMs = CARTON_CODE_MEMORY_MS) {}

  /** Remember this frame's carton codes and forget the stale ones. */
  private note(reads: ReadonlyArray<FrameRead>, now: number): void {
    for (const [code, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(code);
    }
    for (const r of reads) {
      if (isCartonCode(r.value)) this.seen.set(r.value, now);
    }
  }

  /** Does a carton code seen within the window carry `code`? */
  claims(code: string): boolean {
    for (const carton of this.seen.keys()) {
      if (belongsToCartonCode(code, carton)) return true;
    }
    return false;
  }

  /**
   * Record the frame's carton codes, then return its reads without the short
   * codes a remembered (or same-frame) carton code claims. Returns the same
   * array when nothing is dropped.
   */
  filter<T extends FrameRead>(reads: T[], now: number): T[] {
    this.note(reads, now);
    if (this.seen.size === 0) return reads;
    const out = reads.filter((r) => !this.claims(r.value));
    return out.length === reads.length ? reads : out;
  }

  reset(): void {
    this.seen.clear();
  }
}
