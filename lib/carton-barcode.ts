/**
 * What a decoded carton barcode is allowed to mean (2026-09-17, after the
 * IN264171048 demo).
 *
 * Two kinds of carton label reach the scanner:
 *
 *  * catch-weight meat: a GS1-128 of 20+ digits carrying the item, this
 *    carton's own weight, a serial and the expiry. Every carton is different,
 *    so the barcode IS the carton — reading it twice is the same carton twice.
 *  * fixed-weight goods (kebabonim, fish, produce cartons): a plain EAN-13 /
 *    GTIN that says only "this product". All 15 cartons on the note carry the
 *    identical barcode. Refusing the second read as a duplicate — which is
 *    what the scanner did — meant 1 of 15 could ever be booked, and the only
 *    way past was a misread that happened to differ by a digit.
 *
 * So: a per-carton-unique barcode is deduped on its digits; a label barcode
 * is deduped too UNTIL the worker opts in for that product (pallet-verify's
 * LabelPrompt, asked once after the first carton's OCR). From then on each
 * read — after the scanner's double-trigger guard AND the repeat gate in
 * lib/repeat-gate.ts (the code must leave the frame between cartons) — is
 * another carton, with its own photo and OCR, under a `-B`, `-C`, … suffix
 * that is stripped before the wire. Never a count typed in, never a clone.
 *
 * And a read that cannot be a carton barcode at all (a fragment, or an EAN
 * whose check digit fails) is refused with the digits shown, never stored:
 * a phantom SKU created from a misread is worse than a rescan.
 */

export const REPEAT_SUFFIX_RE = /-[A-Z]+$/;

export function digitsOf(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

/** True when the barcode identifies ONE carton (catch-weight GS1-128 with a
 *  serial/weight), false for a product-level label that every carton shares. */
export function isPerCartonUnique(barcode: string): boolean {
  return digitsOf(baseBarcode(barcode)).length >= 20;
}

/** Strip the repeat suffix: `7290004456825-C` → `7290004456825`. Never touches
 *  the provisional `MANUAL-…` / `NOBC-…` ids (their tails are not upper-case
 *  letters only). */
export function baseBarcode(key: string): string {
  return key.replace(REPEAT_SUFFIX_RE, '');
}

function letters(n: number): string {
  // 1 → B, 2 → C … 25 → Z, 26 → BA … (base-25 over B..Z so the suffix is
  // never empty and never starts with A, which keeps "-A" free for nothing).
  let out = '';
  let v = n;
  while (v > 0) {
    v -= 1;
    out = String.fromCharCode(66 + (v % 25)) + out;
    v = Math.floor(v / 25);
  }
  return out;
}

/** The key to store a REPEATED label barcode under: the first of
 *  `<base>-B`, `<base>-C`, … not already in `taken`. */
export function repeatKey(barcode: string, taken: { has(k: string): boolean }): string {
  const base = baseBarcode(barcode.trim());
  for (let n = 1; n < 700; n += 1) {
    const k = `${base}-${letters(n)}`;
    if (!taken.has(k)) return k;
  }
  return `${base}-${letters(700)}`;
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
  const d = digitsOf(baseBarcode(barcode));
  if (d.length < 12) return { ok: false, reason: 'too_short' };
  if (d.length <= 14 && !gtinCheckDigitValid(d)) return { ok: false, reason: 'checksum' };
  return { ok: true };
}
