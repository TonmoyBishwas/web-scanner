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
  | { ok: false; reason: 'too_short' | 'checksum' | 'pallet_label' | 'not_digits' };

/**
 * The supplier's own SHIPPING-PALLET label (MEV-10, 2026-09-22): Baladi prints
 * a 16-digit `1000000000…` number on the pallet and as משטח שילוח on the note
 * (1000000000529677 on IN264171048; 1000000000513550 scanned on IN264172698
 * and counted as a sixth carton). It is the pallet's identity, never a carton.
 */
export const SUPPLIER_PALLET_LABEL = /^1000000000\d{6}$/;
export function isSupplierPalletLabel(digits: string): boolean {
  return SUPPLIER_PALLET_LABEL.test(digits);
}

/**
 * Can this read be a carton barcode?
 *  * anything but digits → refuse (SCN-13: `729011535108401430767802907229:`
 *    was booked on 2026-10-04 with its `:`; the digits-only check below used
 *    to strip it and wave the read through). Surrounding whitespace is not
 *    part of the read; the callers trim it;
 *  * fewer than 12 digits → a fragment of a longer code or a stray small
 *    symbol on the sticker (IN264171048 stored `15928481` off a 31-digit
 *    catch-weight label) → refuse;
 *  * 12 / 13 / 14 digits → must pass the GTIN check digit (`7290001456825`,
 *    a one-digit misread of `7290004456825`, fails it) → else refuse;
 *  * 15+ digits → a GS1-128; the symbology has its own checksum → accept,
 *    EXCEPT an Israeli (`729…`) catch-weight code whose leading 13 digits
 *    fail the GTIN check (`729010351484015205456509092027`, a shifted read of
 *    `7290115351484…`, 2026-10-04) — see `isIsraeliGtinPrefixed`.
 */
export function classifyRead(barcode: string): ReadVerdict {
  const raw = (barcode || '').trim();
  if (/\D/.test(raw)) return { ok: false, reason: 'not_digits' };
  const d = raw;
  if (isSupplierPalletLabel(d)) return { ok: false, reason: 'pallet_label' };
  if (d.length < 12) return { ok: false, reason: 'too_short' };
  if (d.length <= 14 && !gtinCheckDigitValid(d) && !isInHouseCode(d)) {
    return { ok: false, reason: 'checksum' };
  }
  if (d.length >= 15 && isIsraeliGtinPrefixed(d) && !gtinCheckDigitValid(d.slice(0, 13))) {
    return { ok: false, reason: 'checksum' };
  }
  return { ok: true };
}

/**
 * Does a 15+ digit read claim to start with an Israeli GTIN-13 (prefix 729),
 * so its first 13 digits must carry a valid check digit?
 *
 * Not `7290000…`: one supplier (invoices 251068506 / 251068650, 2026-10-03..05,
 * 37 cartons) prints `7290000` + his own zero-padded item number
 * (`7290000000101`, `7290000002283`, `7290000000550` = note lines 101 / 2283 /
 * 550) — read identically every time, and none of them passes the GTIN check.
 * Every other `729…` prefix in 90 days of box_inventory does. Other prefixes
 * (`10…`, `28…` minted labels, …) are not touched: `1014721100101` is
 * legitimate and fails a GTIN check.
 */
export function isIsraeliGtinPrefixed(digits: string): boolean {
  return digits.startsWith('729') && !digits.startsWith('7290000');
}

/**
 * GS1 "restricted circulation" prefixes 20–29 (and 02) are in-house codes:
 * the supplier numbers them himself and owes nobody a GTIN check digit.
 * Baladi's carton label `2000090300667` (= "20000" + his item 90300667) has
 * a check digit of 7 where GS1 arithmetic says 8, and on 2026-09-23 every
 * one of 70 cartons was refused as a misread — the camera read it right 25
 * times. A 13-digit code starting with 2 is taken as printed.
 */
export function isInHouseCode(digits: string): boolean {
  return digits.length === 13 && /^(2|02)/.test(digits);
}

/**
 * The same checksum-failing digits, confirmed on three SEPARATE captures
 * (each already three identical frames), are not a camera guess: the label
 * really prints them. Mechanical gate, per session — the worker never has
 * to type a number the camera keeps reading.
 */
export const REPEATED_READ_ACCEPT_AT = 3;
export function noteRepeatedRead(counts: Map<string, number>, digits: string): boolean {
  const n = (counts.get(digits) || 0) + 1;
  counts.set(digits, n);
  return n >= REPEATED_READ_ACCEPT_AT;
}

/**
 * A short read that IS an invoice line's item code (2026-10-15, IN26013461):
 * Milgam's corn-schnitzel cartons carry one barcode, `501004` — the supplier's
 * item code, equal to the note's מק"ט. `classifyRead` refused it as a fragment
 * 27 times in a row ("only part of the barcode was read") and the worker
 * never found the way out. Such a carton has no unique code, so it cannot be
 * booked under the read; the page opens New carton prefilled with this line
 * instead (the worker states the count — nothing is counted from the read).
 *
 * Match: the read (digits only, ≥ SHORT_ITEM_CODE_MIN digits) equals a line's
 * item code, or does once leading zeros are stripped from both (`0501004` /
 * `501004`; the stripped form must still be ≥ SHORT_ITEM_CODE_MIN digits, so
 * `0300` never matches `300`). Lines are matched on `item_code` and, when a
 * session carries one, `supplier_code` / `supplier_item_code`. Two different
 * items matching is ambiguous → no match (refused as before).
 */
export const SHORT_ITEM_CODE_MIN = 4;

export interface ShortCodeLine {
  item_code?: string | null;
  supplier_code?: string | null;
  supplier_item_code?: string | null;
}

function stripZeros(d: string): string {
  return d.replace(/^0+/, '');
}

export function matchInvoiceShortCode<T extends ShortCodeLine>(
  read: string | null | undefined,
  lines: readonly T[] | null | undefined,
): T | null {
  const raw = (read || '').trim();
  if (!/^\d+$/.test(raw) || raw.length < SHORT_ITEM_CODE_MIN) return null;
  const stripped = stripZeros(raw);
  let hit: T | null = null;
  for (const line of lines ?? []) {
    const codes = [line.item_code, line.supplier_code, line.supplier_item_code]
      .map((c) => digitsOf(c == null ? '' : String(c)))
      .filter((c) => c.length > 0);
    const matches = codes.some((c) =>
      c === raw || (stripped.length >= SHORT_ITEM_CODE_MIN && stripZeros(c) === stripped));
    if (!matches) continue;
    if (hit && stripZeros(String(hit.item_code ?? '').trim()) !== stripZeros(String(line.item_code ?? '').trim())) return null;
    if (!hit) hit = line;
  }
  return hit;
}

/**
 * New-carton defaults for a short-code match: weight per carton from the
 * invoice when derivable (`unit_weight_kg`, else `quantity_kg / box_count`,
 * rounded to 3 decimals) and the cartons of that line still to count
 * (`box_count − counted`, at least 1). Both are only defaults on the form —
 * the worker sees, changes and saves them himself.
 */
export function shortCodeDefaults(
  line: { quantity_kg?: number | null; box_count?: number | null; unit_weight_kg?: number | null },
  counted: number,
): { weight: number | null; quantity: number } {
  const boxes = Number(line.box_count) || 0;
  const kg = Number(line.quantity_kg) || 0;
  const unit = Number(line.unit_weight_kg) || 0;
  let weight: number | null = null;
  if (unit > 0) weight = unit;
  else if (boxes > 0 && kg > 0) weight = Math.round((kg / boxes) * 1000) / 1000;
  const quantity = boxes > 0 ? Math.max(1, boxes - Math.max(0, counted)) : 1;
  return { weight, quantity };
}
