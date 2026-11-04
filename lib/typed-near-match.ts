/**
 * Typed digits one short of a code already on the list (04/11, flag
 * `typed_near_match`, lib/scanner-flags.ts).
 *
 * The edit panel asks for the digits under the bars of a carton the camera
 * could not read, and refuses anything under 13 digits. On a Baladi pallet
 * David typed 200009700258 for a label that prints 2000097200258 (the '2'
 * after '97' dropped): refused, with nothing pointing him to the code already
 * on the list, and the pallet was left behind.
 *
 * `typedNearMatch` finds the code he most likely meant: a code of 13+ digits
 * on the SAME list that equals the typed digits with exactly ONE digit
 * inserted. The page then treats it like typing that code in full — which
 * is a duplicate of a carton on the list, so the existing question and its
 * two buttons (same carton / another carton with an identical label) follow.
 *
 * Only a single, unambiguous code counts: when several codes fit, the ones
 * whose row carries the edited carton's item name are preferred, and if that
 * still leaves more than one (or none fit at all) the result is null and the
 * page keeps today's "too few digits" refusal.
 *
 * Never a 12-digit format: no UPC-A carton has ever been booked, and a code
 * shorter than 13 digits breaks the slice(0, 13) item identity everywhere.
 */
import { isMintedLabelBarcode } from './label-batches';

export interface NearMatchRow {
  barcode: string;
  source_barcode?: string;
  item_name?: string;
  item_name_hebrew?: string;
}

/** Is `long` exactly `short` with one character inserted somewhere? */
export function isOneDigitInsertion(short: string, long: string): boolean {
  if (long.length !== short.length + 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  // Skip long[i] (the inserted digit); the rest must line up.
  return long.slice(i + 1) === short.slice(i);
}

/** A whole code of 13+ digits — never a MANUAL-/NOBC- marker's digits, never a minted 28… label. */
function supplierCode(code: string | undefined): string | null {
  const c = (code || '').trim();
  if (!/^\d{13,}$/.test(c)) return null;
  if (isMintedLabelBarcode(c)) return null;
  return c;
}

export function typedNearMatch<T extends NearMatchRow>(
  typed: string,
  rows: ReadonlyArray<T>,
  opts: { exceptBarcode?: string; nameHe?: string; nameEn?: string; minDigits?: number } = {},
): string | null {
  const minDigits = opts.minDigits ?? 13;
  const digits = (typed || '').replace(/\D/g, '');
  if (digits.length === 0 || digits.length >= minDigits) return null;
  // Candidate code → do any of its rows carry the edited carton's name?
  const nameHe = (opts.nameHe || '').trim();
  const nameEn = (opts.nameEn || '').trim();
  const candidates = new Map<string, boolean>();
  for (const r of rows) {
    if (opts.exceptBarcode !== undefined && r.barcode === opts.exceptBarcode) continue;
    for (const code of [supplierCode(r.barcode), supplierCode(r.source_barcode)]) {
      if (!code || code.length < minDigits || !isOneDigitInsertion(digits, code)) continue;
      const sameName = nameHe
        ? (r.item_name_hebrew || '').trim() === nameHe
        : !!nameEn && (r.item_name || '').trim() === nameEn;
      candidates.set(code, (candidates.get(code) ?? false) || sameName);
    }
  }
  if (candidates.size === 1) return candidates.keys().next().value ?? null;
  if (candidates.size === 0) return null;
  const named = [...candidates.entries()].filter(([, same]) => same).map(([code]) => code);
  return named.length === 1 ? named[0] : null;
}
