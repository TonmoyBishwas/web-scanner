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
  /** The 4 weight digits, in 10 g (`1011` = 10.11 kg); not a weight for a `140010` units item. */
  weight: string;
  /** The last 9 digits: unique per carton (879 of 879 in box_inventory, 01/11). */
  serial: string;
}

/** A Glatt 25-digit code with one of Glatt's mids, else null. */
export function parseGlattCode(code: string | null | undefined): GlattCode | null {
  const m = GLATT_SHAPE.exec((code || '').trim());
  if (!m || !GLATT_MIDS.includes(m[2])) return null;
  return { item: m[1], mid: m[2], weight: m[3], serial: m[4] };
}

/** The carton weight a Glatt code prints, in kg (null for a `140010` units item). */
export function glattWeightKg(g: GlattCode): number | null {
  if (g.mid === '140010') return null;
  const kg = Number(g.weight) / 100;
  return kg > 0 ? kg : null;
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
 * The same Glatt carton under two strings (01/11: `4721100101530065729703`
 * booked from a photo, `1014721100101530065729703` read by the camera — one
 * carton, never two).
 *  * two valid Glatt codes: the same 9-digit serial (unique per carton);
 *  * a valid code and a damaged one (looksLikeDamagedGlatt / a misread mid):
 *    the same last 13 digits — weight (4) + serial (9). The serial alone is
 *    not enough there: Glatt serials run in sequence (`…065729703` and
 *    `…065729707` were on one note), so a damaged string whose serial was
 *    misread as a neighbour's would make the neighbour's real carton look
 *    "already counted" and lose it.
 */
export function sameGlattCarton(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a || '').trim();
  const y = (b || '').trim();
  if (!x || !y) return false;
  const px = parseGlattCode(x);
  const py = parseGlattCode(y);
  if (px && py) return px.serial === py.serial;
  if (!px && !py) return false;
  const other = px ? y : x;
  if (!looksLikeDamagedGlatt(other) && !isGlattMisread(other)) return false;
  return x.length >= 13 && y.length >= 13 && x.slice(-13) === y.slice(-13);
}

/** Is `code` on this set of codes, as itself or as the same Glatt carton? */
export function hasCartonCode(codes: Iterable<string>, code: string | null | undefined): boolean {
  const c = (code || '').trim();
  if (!c) return false;
  if (codes instanceof Set && codes.has(c)) return true;
  for (const k of codes) if (k === c || sameGlattCarton(k, c)) return true;
  return false;
}

/** How far (in serial numbers) a one-read carton may be from a carton of its item already counted. */
export const TRUST_SERIAL_SPAN = 2000;
/** How far (as a fraction) its printed weight may be from the item's typical carton. */
export const TRUST_WEIGHT_TOLERANCE = 0.15;

export interface NoteLine {
  item_code?: string | number | null;
  quantity_kg?: number | string | null;
  expected_boxes?: number | string | null;
}

export interface TrustContext {
  /**
   * Codes already counted in this session (any pallet). The valid Glatt codes
   * among them anchor the serial and the weight of their item.
   */
  anchors?: Iterable<string>;
  /** The other values waiting in the confirmer right now (unconfirmed reads). */
  pending?: Iterable<string>;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Does a single read of `value` identify a carton of THIS note beyond doubt?
 * (01/11, note 261062322.) On Glatt's thin print the decoders give a
 * different misread almost every frame, so the valid string may be seen only
 * once — and "two identical reads in 3 s" (lib/barcode-frame.ts) let it
 * expire. One read is trusted only when ALL of these hold:
 *  1. it is a valid Glatt code (one of Glatt's mids) whose item code is one
 *     of the note's lines — refuses the regex-valid misreads of that session
 *     (`1006781100101369069565401`, `1120671100101720069560708`: items
 *     00678 / 12067, on no line);
 *  2. something else vouches for its serial: a carton of the same item
 *     already counted in this session within ±TRUST_SERIAL_SPAN serials
 *     (serials run in sequence: the median gap to the nearest same-item,
 *     same-day carton in 120 days of box_inventory is 1), or another read
 *     waiting in the confirmer ends in the same 9 digits (the client's
 *     meatball carton: its misread `…111510…067936150` was read twice beside
 *     it). A misread inside the serial keeps the item and the mid, so the
 *     item check alone cannot catch it — `1050861100100814067902118`, read
 *     once in session LGUtpTw2 for the real `1050861100101014067935118`,
 *     is 33 000 serials from any carton of its item;
 *  3. its printed weight is within ±TRUST_WEIGHT_TOLERANCE of the item's
 *     typical carton, when that is known: the note line's kg ÷ cartons, else
 *     the median of ≥ 3 cartons of the item already counted (that phantom
 *     prints 8.14 kg; meatball cartons weigh 10.07–10.21).
 * The first carton of each item therefore still needs two reads.
 *
 * The 31-digit catch-weight family is NOT trusted on one read: a note line's
 * item code is the supplier's short code, which the code's GTIN never equals
 * (CLAUDE.md), so the "this note's line" check cannot be made for it.
 */
export function trustedSingleRead(
  value: string,
  lines: ReadonlyArray<NoteLine> | null | undefined,
  ctx: TrustContext = {},
): boolean {
  const code = (value || '').trim();
  const g = parseGlattCode(code);
  if (!g) return false;
  const item = stripZeros(g.item);
  if (!item) return false;
  const line = (lines ?? []).find((l) => stripZeros(digitsOf(l.item_code == null ? '' : String(l.item_code))) === item);
  if (!line) return false;

  const sameItem: GlattCode[] = [];
  for (const a of ctx.anchors ?? []) {
    const p = (a || '').trim() === code ? null : parseGlattCode(a);
    if (p && p.item === g.item) sameItem.push(p);
  }
  const serial = Number(g.serial);
  const near = sameItem.some((p) => Math.abs(Number(p.serial) - serial) <= TRUST_SERIAL_SPAN);
  let twin = false;
  if (!near) {
    for (const v of ctx.pending ?? []) {
      const d = (v || '').trim();
      if (d === code || d.slice(-9) !== g.serial) continue;
      if (parseGlattCode(d) || looksLikeDamagedGlatt(d) || isGlattMisread(d)) { twin = true; break; }
    }
  }
  if (!near && !twin) return false;

  const kg = glattWeightKg(g);
  if (kg !== null) {
    const qty = Number(line.quantity_kg);
    const boxes = Number(line.expected_boxes);
    const fromLine = qty > 0 && boxes > 0 ? qty / boxes : null;
    const listedKg = sameItem.map(glattWeightKg).filter((w): w is number => w !== null);
    const typical = fromLine ?? (listedKg.length >= 3 ? median(listedKg) : null);
    if (typical && Math.abs(kg / typical - 1) > TRUST_WEIGHT_TOLERANCE) return false;
  }
  return true;
}

/**
 * The confirmer's read policy for an inbound list (lib/barcode-frame.ts
 * ReadPolicy): a Glatt misread mid is ignored (never confirmed); a trusted
 * single read (trustedSingleRead, with the confirmer's other waiting reads)
 * confirms on one read — unless that carton is already on the list
 * (`listed`). A carton already counted still needs two reads: one glimpse of
 * it while the worker moves on would otherwise re-arm the scanner's 3 s
 * cooldown and throw away the next carton's read (seen in the replay of
 * session hceJxe4obaK2TgXOdVXfu, 01/11). `anchors` = every code counted in
 * this session (default: `listed`). The confirmer honours `trust` only for
 * the read nearest the centre of its frame.
 */
export function inboundReadPolicy(
  lines: () => ReadonlyArray<NoteLine> | null | undefined,
  listed: () => Iterable<string>,
  anchors?: () => Iterable<string>,
): (value: string, ctx?: { pending?: Iterable<string> }) => 'trust' | 'ignore' | undefined {
  return (value, ctx) => {
    const code = (value || '').trim();
    if (isGlattMisread(code)) return 'ignore';
    if (hasCartonCode(listed(), code)) return undefined;
    const anchorCodes = anchors ? anchors() : listed();
    return trustedSingleRead(code, lines(), { anchors: anchorCodes, pending: ctx?.pending }) ? 'trust' : undefined;
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
  // A 6–11 digit per-carton serial (Wall Dan 408274) is booked when the label
  // photo confirmed it (labelConfirmsShortCode) or, on a short-serial
  // supplier's receipt with the camera_short_serial flag on, from the camera
  // (cameraSerialAccepted); either way it has no format to check.
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
 *    see matchInvoiceShortCode), nor a piece of one (04/11);
 *  * not carried by a long code already on the list (lib/frame-reads.ts
 *    belongsToCartonCode);
 *  * not the supplier's shipping-pallet label.
 * (shortSerialExcluded — the camera path, cameraSerialAccepted, uses the same.)
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
  return !shortSerialExcluded(ocrDigits, lines, listedCodes);
}

/**
 * The things a short code already is, so it can never be a carton's own
 * serial — one list for the photo path (labelConfirmsShortCode) and the
 * camera path (cameraSerialAccepted), so the two cannot drift apart:
 *  * an invoice line's item code (matchInvoiceShortCode: `501004` keeps its
 *    New-carton route);
 *  * a piece of a line's code (`628936` inside 7290006289360, the line of
 *    Wall Dan note 48651 — 04/11);
 *  * carried by a long code already on the list (belongsToCartonCode);
 *  * the supplier's shipping-pallet label.
 */
export function shortSerialExcluded(
  d: string,
  lines: readonly ShortCodeLine[] | null | undefined,
  listedCodes: readonly string[],
): boolean {
  if (matchInvoiceShortCode(d, lines) !== null) return true;
  for (const line of lines ?? []) {
    const codes = [line.item_code, line.supplier_code, line.supplier_item_code]
      .map((c) => digitsOf(c == null ? '' : String(c)));
    if (codes.some((c) => c.length > 0 && c.includes(d))) return true;
  }
  if (listedCodes.some((code) => belongsToCartonCode(d, code))) return true;
  return isSupplierPalletLabel(d);
}

/**
 * Suppliers whose cartons carry only a short per-carton serial (item 1,
 * 04/11). Wall Dan (וול דאן מוצרי בשר בע"מ, VAT 515215705) prints a 6-digit
 * running number under the bars (409251, 379300) and nothing longer: notes
 * 48288, 48429, 48534, 48651 and 48696. Matched on deliveries.supplier_vat
 * (lib/scanner-flags.ts cameraShortSerialOn). A new supplier is a code change.
 */
export const SHORT_SERIAL_SUPPLIER_VATS: readonly string[] = ['515215705'];

/** A camera-bookable serial: exactly 6 digits, no leading zero (`020926`, a fragment of a 30-digit code on 48288, stays out). */
export const CAMERA_SERIAL_RE = /^[1-9]\d{5}$/;

/**
 * May the camera book this short read as the carton's own serial? Only the
 * shape and the exclusions (shortSerialExcluded) — the flag and the
 * supplier are the caller's (the page's `features.camera_short_serial`).
 * The read still needs the confirmer's two identical reads, and the label
 * reader's printed digits are then checked against it
 * (cameraSerialOcrVerdict).
 */
export function cameraSerialAccepted(
  read: string,
  lines: readonly ShortCodeLine[] | null | undefined,
  knownCodes: readonly string[],
): boolean {
  const d = (read || '').trim();
  return CAMERA_SERIAL_RE.test(d) && !shortSerialExcluded(d, lines, knownCodes);
}

/**
 * The page's question (acceptScannerValue and the detect handlers): the
 * session's `features.camera_short_serial` (the flag on for this chat AND a
 * short-serial supplier's receipt) and cameraSerialAccepted. Off → false for
 * every read, so the page refuses the short read as before.
 */
export function cameraSerialBookable(
  features: { camera_short_serial?: boolean } | null | undefined,
  read: string,
  lines: readonly ShortCodeLine[] | null | undefined,
  knownCodes: readonly string[],
): boolean {
  return !!features?.camera_short_serial && cameraSerialAccepted(read, lines, knownCodes);
}

/**
 * The label reader's printed digits against a camera-booked serial:
 *  * 'agrees' — the same number;
 *  * 'unread' — no digits, or fewer than 6 (nothing to compare);
 *  * 'other'  — anything else, a long code that contains the serial
 *    included (the camera may have read a piece of it). The row then goes
 *    to the edit panel (needs_review); it is never re-keyed.
 */
export function cameraSerialOcrVerdict(serial: string, ocrDigits: string | null | undefined): 'agrees' | 'unread' | 'other' {
  const digits = digitsOf(ocrDigits);
  if (digits === serial) return 'agrees';
  if (digits.length < 6) return 'unread';
  return 'other';
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
