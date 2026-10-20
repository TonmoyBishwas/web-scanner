/**
 * Match an OCR'd box-sticker name against the delivery's invoice item list.
 *
 * Box-sticker Hebrew OCR is noisy and varies run-to-run, which fragments one
 * physical item into several name groups. But the invoice gives a tiny closed
 * set of the exact items expected on the delivery, so we snap each OCR'd name
 * to the closest invoice line. Grouping then uses the canonical invoice name,
 * eliminating drift-induced fragmentation.
 *
 * Matching ladder (most → least confident):
 *   0. the carton's own code (`codes`, optional): an invoice item code of 12+
 *      digits that IS the carton's barcode, or its GS1 prefix — the label
 *      says which product it is, whatever name the OCR read (19/10 incident
 *      below, matchInvoiceItemByCode)
 *   1. exact normalized Hebrew, then exact normalized English
 *   2. first-Hebrew-word prefix (invoice OCR sometimes captures a shorter form)
 *   3. fuzzy: normalized Levenshtein similarity ≥ FUZZY_THRESHOLD
 *   4. distinctive words: the sticker shares a product word with exactly one
 *      invoice line ("אחדות חזה עוף גדול קפוא" ↔ "חזה עוף גדול תפ לנדא" —
 *      the sticker leads with a brand the invoice doesn't print)
 *
 * Returns the matched invoice line, or null when nothing matches confidently
 * (e.g. a loose / unlisted box) — callers then keep the raw OCR name.
 */
import { normalizeString } from './string-utils';

export interface InvoiceItem {
  item_code: string;
  item_name_hebrew: string;
  item_name_english: string;
  quantity_kg?: number;
  /** Source supplier invoice for this line (multi-invoice delivery). */
  document_number?: string;
}

// Two clearly-different products rarely exceed ~0.8 normalized similarity;
// OCR drift on the same product (a missing suffix/letter) stays well above it.
const FUZZY_THRESHOLD = 0.82;

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Similarity in [0,1] = 1 − editDistance / maxLen. */
function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Find the invoice item best matching the given OCR'd names. Returns the
 * matched line or null. Pure + deterministic so it can run client-side
 * (pallet-verify snap) and server-side (multi-pallet-complete) identically.
 */
export function matchInvoiceItem(
  nameHebrew: string | undefined,
  nameEnglish: string | undefined,
  invoiceItems: InvoiceItem[] | undefined,
  /** The carton's own codes (barcode, the supplier code a label stands in
   *  for, OCR'd printed digits) — step 0. Omitted: names only, as before. */
  codes?: ReadonlyArray<string | null | undefined>,
): InvoiceItem | null {
  if (!invoiceItems || invoiceItems.length === 0) return null;

  // 0. the carton's own code
  if (codes) {
    const byCode = matchInvoiceItemByCode(codes, invoiceItems);
    if (byCode) return byCode;
  }
  return matchInvoiceItemByName(nameHebrew, nameEnglish, invoiceItems);
}

/**
 * Item codes shorter than this are never looked for inside a carton barcode:
 * a 5–6 digit short code (`501004`) would match the start of unrelated
 * barcodes by chance. 12+ digits is a GTIN, which names one product.
 */
const MIN_CODE_DIGITS = 12;

const codeDigits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * The invoice line whose item code the carton's own code carries: the code
 * itself, or the code as the barcode's GS1 prefix (a 31-digit catch-weight
 * label starts with its GTIN). Null when no line's code is there, or when
 * two different lines would both fit.
 *
 * Why (IN264191356, 19/10): a photo of a beef-meatball carton read its
 * printed digits `2000097200258` — exactly the meatball line's item code —
 * and the name 'קבב -גורמה' (Kebab - Gourmet) off the kebab sticker beside
 * it. The name ladder snapped it to the kebab line on its first word, and
 * "All boxes identical" then minted 7 meatball cartons as kebab. The barcode
 * was right; the name belonged to another carton.
 */
export function matchInvoiceItemByCode(
  codes: ReadonlyArray<string | null | undefined>,
  invoiceItems: InvoiceItem[] | undefined,
): InvoiceItem | null {
  if (!invoiceItems || invoiceItems.length === 0) return null;
  const own = codes.map(codeDigits).filter((c) => c.length >= MIN_CODE_DIGITS);
  if (own.length === 0) return null;
  let hit: InvoiceItem | null = null;
  for (const line of invoiceItems) {
    const code = codeDigits(line.item_code);
    if (code.length < MIN_CODE_DIGITS) continue;
    if (!own.some((c) => c === code || c.startsWith(code))) continue;
    // Two lines with one code (a multi-invoice delivery) are one product.
    if (hit && codeDigits(hit.item_code) !== code) return null;
    hit ??= line;
  }
  return hit;
}

/**
 * A list row's own codes for step 0 of matchInvoiceItem: its barcode and the
 * supplier code a minted label stands in for — or none at all once the
 * worker has settled which product the carton is (`named_by_worker`: he
 * picked it in the identical form's "which product?", or saved a name of
 * his own in the edit panel). His choice then decides by name, as the
 * server books it: a meatball-coded carton he settled as kebab must not
 * mint labels carrying the meatball line's item_code beside kebab names.
 */
export function cartonOwnCodes(b: { barcode: string; source_barcode?: string; named_by_worker?: boolean }): string[] {
  return b.named_by_worker ? [] : [b.barcode, b.source_barcode || ''];
}

/**
 * The carton's code says one invoice line and its OCR'd name another — the
 * 19/10 meatball/kebab shape. Both lines, for a soft "which product?" (the
 * code's line is what the carton is booked as). Null when either is missing
 * or they agree.
 */
export function invoiceNameConflict(
  nameHebrew: string | undefined,
  nameEnglish: string | undefined,
  invoiceItems: InvoiceItem[] | undefined,
  codes: ReadonlyArray<string | null | undefined>,
): { byCode: InvoiceItem; byName: InvoiceItem } | null {
  const byCode = matchInvoiceItemByCode(codes, invoiceItems);
  if (!byCode) return null;
  const byName = matchInvoiceItemByName(nameHebrew, nameEnglish, invoiceItems ?? []);
  if (!byName || codeDigits(byName.item_code) === codeDigits(byCode.item_code)) return null;
  return { byCode, byName };
}

/** Steps 1–4 of the ladder: names only. */
function matchInvoiceItemByName(
  nameHebrew: string | undefined,
  nameEnglish: string | undefined,
  invoiceItems: InvoiceItem[],
): InvoiceItem | null {
  if (invoiceItems.length === 0) return null;

  const heNorm = normalizeString(nameHebrew);
  const enNorm = normalizeString(nameEnglish);

  // 1. exact normalized match (Hebrew first, then English)
  for (const line of invoiceItems) {
    if (heNorm && normalizeString(line.item_name_hebrew) === heNorm) return line;
  }
  for (const line of invoiceItems) {
    if (enNorm && normalizeString(line.item_name_english) === enNorm) return line;
  }

  // 2. first-Hebrew-word prefix
  const firstWord = nameHebrew?.match(/[֐-׿]{3,}/)?.[0];
  if (firstWord) {
    const fw = normalizeString(firstWord);
    for (const line of invoiceItems) {
      if (fw && normalizeString(line.item_name_hebrew).startsWith(fw)) return line;
    }
  }

  // 3. fuzzy — best similarity above threshold, Hebrew preferred then English
  let best: InvoiceItem | null = null;
  let bestScore = FUZZY_THRESHOLD;
  for (const line of invoiceItems) {
    const score = Math.max(
      heNorm ? similarity(heNorm, normalizeString(line.item_name_hebrew)) : 0,
      enNorm ? similarity(enNorm, normalizeString(line.item_name_english)) : 0,
    );
    if (score >= bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (best) return best;

  // 4. distinctive words
  return matchByDistinctiveWords(nameHebrew, invoiceItems);
}

// A sticker naming one species / state must not land on a line naming another.
const SPECIES = ['עוף', 'הודו', 'בקר', 'עגל', 'כבש', 'טלה', 'אווז', 'ברווז', 'דג', 'סלמון'];
const STATES = ['טרי', 'קפוא'];

function hebrewWords(name: string | undefined): string[] {
  return (name || '').split(/[^\u05D0-\u05EA]+/).filter((w) => w.length >= 2);
}

/**
 * Two words of 5+ letters that differ only by one pair of neighbouring letters
 * swapped — a typing slip on the invoice ("שינצלון" for "שניצלון", IN264184055).
 * Same length only, so a longer word never collapses onto a shorter one.
 */
function oneSwapApart(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 5) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

/** Sticker word equals the invoice word, allowing a leading ו ("ושוקיים") or one swapped letter pair. */
function sameWord(stickerWord: string, invoiceWord: string): boolean {
  return (
    stickerWord === invoiceWord || stickerWord === 'ו' + invoiceWord || oneSwapApart(stickerWord, invoiceWord)
  );
}

function clashes(sticker: string[], line: string[], vocab: string[]): boolean {
  const a = vocab.filter((v) => sticker.some((w) => sameWord(w, v)));
  const b = vocab.filter((v) => line.includes(v));
  return a.length > 0 && b.length > 0 && !a.some((v) => b.includes(v));
}

function matchByDistinctiveWords(
  nameHebrew: string | undefined,
  invoiceItems: InvoiceItem[],
): InvoiceItem | null {
  const sticker = hebrewWords(nameHebrew);
  if (sticker.length === 0) return null;
  const lines = invoiceItems.map((l) => hebrewWords(l.item_name_hebrew));

  // Lines the sticker shares a word with that no other line has.
  const hits = new Set<number>();
  lines.forEach((words, i) => {
    // Fresh / frozen describe a state, not which product it is.
    const distinctive = words.filter(
      (w) => !STATES.includes(w) && lines.every((other, j) => j === i || !other.includes(w)),
    );
    if (distinctive.some((d) => sticker.some((s) => sameWord(s, d)))) hits.add(i);
  });
  if (hits.size !== 1) return null;

  const [i] = [...hits];
  if (clashes(sticker, lines[i], SPECIES) || clashes(sticker, lines[i], STATES)) return null;
  return invoiceItems[i];
}
