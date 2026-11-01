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

import { belongsToCartonCode } from './frame-reads';
import { lineUnit } from './units-cartons';

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
  | { ok: false; reason: 'too_short' | 'checksum' | 'pallet_label' | 'not_digits' | 'misread' };

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
 *    `7290115351484…`, 2026-10-04) — see `isIsraeliGtinPrefixed`;
 *  * a Glatt-shaped 25-digit `1…` read whose 6-digit mid is none of Glatt's
 *    (`110010` / `010010` / `110610` / `140010`) → a decoder misread
 *    (`misread`): 01/11, note 261062322, the e2e decoder read
 *    `1050861115101001067936150` (mid `111510`) twice for a printed
 *    `1050861100101011067936150`, and it was confirmed and booked. Every
 *    25-digit `1…` code in 120 days of box_inventory is Glatt (876 valid
 *    mids, 3 misreads).
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
  if (isGlattMisread(d)) return { ok: false, reason: 'misread' };
  return { ok: true };
}

/**
 * Glatt (מ.ב. גלאט עוף למהדרין) carton codes, 25 digits:
 *   1 · item code (5) · mid (6) · weight in 10 g (4) · serial (9)
 * (lib/barcode-weight.ts reads the weight; the mids are the same list).
 * `140010` is a units item: a valid code with no weight.
 */
export const GLATT_MIDS: readonly string[] = ['110010', '010010', '110610', '140010'];
const GLATT_SHAPE = /^1(\d{5})(\d{6})(\d{4})(\d{9})$/;

export interface GlattCode {
  /** The supplier's 5-digit item code, e.g. `05086`. */
  item: string;
  mid: string;
  /** The last 9 digits: unique per carton (879 of 879 in box_inventory, 01/11). */
  serial: string;
}

/** A Glatt 25-digit code with one of Glatt's mids, else null. */
export function parseGlattCode(code: string | null | undefined): GlattCode | null {
  const m = GLATT_SHAPE.exec((code || '').trim());
  if (!m || !GLATT_MIDS.includes(m[2])) return null;
  return { item: m[1], mid: m[2], serial: m[4] };
}

/** Glatt-shaped (25 digits, leading `1`) but with a mid Glatt never prints. */
export function isGlattMisread(code: string | null | undefined): boolean {
  const m = GLATT_SHAPE.exec((code || '').trim());
  return !!m && !GLATT_MIDS.includes(m[2]);
}

/**
 * A digit string that is a damaged Glatt code: 20–27 digits that start with
 * `1` or carry a Glatt mid, and are not themselves a valid Glatt code. The
 * label photo's digits on 01/11 (`10147211001409065729707`,
 * `4721100101530065729703`, `10157811001012830565414`, 22–23 digits) and the
 * decoder's 24/26-digit reads in box_inventory are all this. Not `729…`
 * (a GS1 catch-weight family of its own).
 */
export function looksLikeDamagedGlatt(code: string | null | undefined): boolean {
  const d = (code || '').trim();
  if (!/^\d{20,27}$/.test(d) || d.startsWith('729') || parseGlattCode(d)) return false;
  return d.startsWith('1') || GLATT_MIDS.some((mid) => d.includes(mid));
}

/**
 * The same Glatt carton under two strings: one is a valid Glatt code, the
 * other is that code or a damaged one (looksLikeDamagedGlatt / a misread
 * mid), and both end in the same 9-digit serial. A valid read and an earlier
 * digit-misread of one carton (01/11: `4721100101530065729703` booked from a
 * photo, `1014721100101530065729703` read by the camera) are one carton,
 * never two.
 */
export function sameGlattCarton(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a || '').trim();
  const y = (b || '').trim();
  if (!x || !y) return false;
  const loose = (d: string) => !!parseGlattCode(d) || looksLikeDamagedGlatt(d) || isGlattMisread(d);
  const px = parseGlattCode(x);
  const py = parseGlattCode(y);
  if (!px && !py) return false;
  if (!loose(x) || !loose(y)) return false;
  return x.slice(-9) === y.slice(-9);
}

/** Is `code` on this set of codes, as itself or as the same Glatt carton? */
export function hasCartonCode(codes: Iterable<string>, code: string | null | undefined): boolean {
  const c = (code || '').trim();
  if (!c) return false;
  if (codes instanceof Set && codes.has(c)) return true;
  for (const k of codes) if (k === c || sameGlattCarton(k, c)) return true;
  return false;
}

/**
 * Does a single read of `value` identify a carton of THIS note beyond doubt?
 * (01/11, note 261062322.) On Glatt's thin print the decoders give a
 * different misread almost every frame, so the valid string may be seen only
 * once — and "two identical reads in 3 s" (lib/barcode-frame.ts) let it
 * expire. A valid Glatt code (one of Glatt's mids) whose item code is one of
 * the note's lines is trusted on one read. The item check is what refuses
 * the two regex-valid misreads of that session (`1006781100101369069565401`,
 * `1120671100101720069560708`: items 00678 / 12067, on no line).
 *
 * The 31-digit catch-weight family is NOT trusted on one read: a note line's
 * item code is the supplier's short code, which the code's GTIN never equals
 * (CLAUDE.md), so the "this note's line" check cannot be made for it.
 */
export function trustedSingleRead(
  value: string,
  lines: ReadonlyArray<{ item_code?: string | number | null }> | null | undefined,
): boolean {
  const g = parseGlattCode(value);
  if (!g) return false;
  const item = g.item.replace(/^0+/, '');
  if (!item) return false;
  return (lines ?? []).some((l) => digitsOf(l.item_code == null ? '' : String(l.item_code)).replace(/^0+/, '') === item);
}

/**
 * The confirmer's read policy for an inbound list (lib/barcode-frame.ts
 * ReadPolicy): a Glatt misread mid is ignored (never confirmed); a trusted
 * single read (trustedSingleRead) confirms on one read — unless that carton
 * is already on the list (`listed`). A carton already counted still needs two
 * reads: one glimpse of it while the worker moves on would otherwise re-arm
 * the scanner's 3 s cooldown and throw away the next carton's read (seen in
 * the replay of session hceJxe4obaK2TgXOdVXfu, 01/11).
 */
export function inboundReadPolicy(
  lines: () => ReadonlyArray<{ item_code?: string | number | null }> | null | undefined,
  listed: () => Iterable<string>,
): (value: string) => 'trust' | 'ignore' | undefined {
  return (value: string) => {
    const code = (value || '').trim();
    if (isGlattMisread(code)) return 'ignore';
    if (!trustedSingleRead(code, lines())) return undefined;
    return hasCartonCode(listed(), code) ? undefined : 'trust';
  };
}

/**
 * Does a carton code pass its family's format check? Run silently on a
 * photo's printed digits (manual capture) and on every booked code: the
 * answer goes to the bot as `barcode_format_ok`, never to the worker.
 *  * null  — no code, or a 6–11 digit serial (nothing to check);
 *  * false — a read classifyRead refuses (short fragment, failed check
 *    digit, a Glatt misread mid), a damaged Glatt code (looksLikeDamagedGlatt),
 *    or a `729…` catch-weight code missing digits (26–30 long);
 *  * true  — anything else.
 */
export function barcodeFormatOk(code: string | null | undefined): boolean | null {
  const d = (code || '').trim();
  if (!d) return null;
  // A 6–11 digit per-carton serial (Wall Dan 408274) is booked only when the
  // label photo confirmed it (labelConfirmsShortCode); it has no format to check.
  if (/^\d{6,11}$/.test(d)) return null;
  if (!classifyRead(d).ok) return false;
  if (parseGlattCode(d)) return true;
  if (looksLikeDamagedGlatt(d)) return false;
  if (isIsraeliGtinPrefixed(d) && d.length >= 26 && d.length <= 30) return false;
  return true;
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
 *
 * `lineMaySpread`: the line's cartons may sit elsewhere too — another pallet,
 * the loose pile, or New-carton labels already minted for it this session
 * (still waiting after a Delete all). `counted` only sees the open list, so
 * "what's left of the line" would be a guess that books the line twice when
 * accepted; the count then defaults to 1 and the line total is only a hint
 * (`lineTotal`) for the worker to count against.
 */
export function shortCodeDefaults(
  line: { quantity_kg?: number | null; box_count?: number | null; unit_weight_kg?: number | null; unit?: unknown },
  counted: number,
  opts: { lineMaySpread?: boolean } = {},
): { weight: number | null; quantity: number; lineTotal: number | null } {
  const boxes = Number(line.box_count) || 0;
  const kg = Number(line.quantity_kg) || 0;
  const unit = Number(line.unit_weight_kg) || 0;
  let weight: number | null = null;
  // A units line's quantity is units (126 portions / 7 = 18), not kg: no
  // weight to offer — the worker weighs the carton or counts it in units.
  if (lineUnit(line) === 'units') weight = null;
  else if (unit > 0) weight = unit;
  else if (boxes > 0 && kg > 0) weight = Math.round((kg / boxes) * 1000) / 1000;
  const quantity = boxes > 0 && !opts.lineMaySpread ? Math.max(1, boxes - Math.max(0, counted)) : 1;
  return { weight, quantity, lineTotal: boxes > 0 ? boxes : null };
}

/**
 * A short code that IS the carton's own serial (Wall Dan, 2026-10-25,
 * document 48534): Wall Dan prints a 6-digit running number per carton
 * (`408274`, `399577`), and `classifyRead` refuses every one of them as a
 * fragment. The photo was no way out either: the label read printed
 * `408274` correctly, the capture threw it away for being under 13 digits,
 * and the same carton was booked twice as two `NOBC-…` rows.
 *
 * Length alone cannot tell a serial from a fragment — `020926`, six digits
 * off the middle of a Well Done 30-digit code, was read identically three
 * times on 11/10 — so neither does this, and neither does a read count.
 * Two independent readers must agree: the photo's printed number under the
 * bars (`ocrDigits`) is exactly a short code the decoder read on this page
 * (`decodedShort`). For a fragment the label prints the long code, never
 * the piece. And it is still none of the things a short code already is:
 *  * 6 to 11 digits (24755, five, stays out);
 *  * not an invoice line's item code (`501004` keeps its New-carton route,
 *    see matchInvoiceShortCode);
 *  * not carried by a long code already on the list (lib/frame-reads.ts
 *    belongsToCartonCode);
 *  * not the supplier's shipping-pallet label.
 * The carton is then booked under the serial itself, as any carton is under
 * its full barcode — every photo a deliberate capture, a repeat caught as
 * the same carton.
 */
export function labelConfirmsShortCode(
  ocrDigits: string,
  decodedShort: ReadonlySet<string>,
  lines: readonly ShortCodeLine[] | null | undefined,
  listedCodes: readonly string[],
): boolean {
  if (!/^\d{6,11}$/.test(ocrDigits)) return false;
  if (!decodedShort.has(ocrDigits)) return false;
  if (matchInvoiceShortCode(ocrDigits, lines) !== null) return false;
  if (listedCodes.some((code) => belongsToCartonCode(ocrDigits, code))) return false;
  return !isSupplierPalletLabel(ocrDigits);
}

/**
 * Do a manual capture's printed digits identify the carton, so it is booked
 * and deduped under them? 13+ digits, as always, or a short serial the
 * decoder confirmed (labelConfirmsShortCode). Otherwise the capture is
 * booked without a barcode (lib/no-barcode.ts) or sent to review.
 */
export function printedDigitsIdentifyCarton(
  digits: string,
  decodedShort: ReadonlySet<string>,
  lines: readonly ShortCodeLine[] | null | undefined,
  listedCodes: readonly string[],
): boolean {
  return digits.length >= 13 || labelConfirmsShortCode(digits, decodedShort, lines, listedCodes);
}
