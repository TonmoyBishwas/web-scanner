/**
 * Can a decoded read be a carton barcode at all? (SCN-13, 2026-09-17)
 *
 * A barcode is an identifier and nothing else: every carton row is deduped on
 * its digits, whatever their length. What this module refuses is a read that
 * cannot be a carton barcode — a fragment of a longer code, or an EAN whose
 * check digit fails — because a phantom SKU created from a camera guess is
 * worse than a rescan.
 *
 * Products that print ONE barcode on every carton are handled by the worker,
 * not here: the "all boxes identical" action on a captured row mints a unique
 * printed label per carton (see lib/identical-boxes.ts). Nothing is inferred
 * from the barcode's shape.
 */

export function digitsOf(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

/** GS1 mod-10 check (EAN-8 / UPC-A / EAN-13 / GTIN-14). */
export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  // Weights 3,1,3,1… from the RIGHTMOST body digit.
  for (let i = 0; i < body.length; i += 1) {
    const d = Number(body[body.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

export type ReadVerdict =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'checksum' };

/**
 * Can this read be a carton barcode?
 *  * fewer than 12 digits → a fragment of a longer code or a stray small
 *    symbol on the sticker (IN264171048 stored `15928481` off a 31-digit
 *    catch-weight label) → refuse;
 *  * 12 / 13 / 14 digits → must pass the GTIN check digit (`7290001456825`,
 *    a one-digit misread of `7290004456825`, fails it) → else refuse;
 *  * 15+ digits → a GS1-128; the symbology has its own checksum → accept.
 */
export function classifyRead(barcode: string): ReadVerdict {
  const d = digitsOf(barcode);
  if (d.length < 12) return { ok: false, reason: 'too_short' };
  if (d.length <= 14 && !gtinCheckDigitValid(d)) return { ok: false, reason: 'checksum' };
  return { ok: true };
}
