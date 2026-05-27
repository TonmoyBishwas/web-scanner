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
 *   1. exact normalized Hebrew, then exact normalized English
 *   2. first-Hebrew-word prefix (invoice OCR sometimes captures a shorter form)
 *   3. fuzzy: normalized Levenshtein similarity ≥ FUZZY_THRESHOLD
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
}

// Two clearly-different products rarely exceed ~0.8 normalized similarity;
// OCR drift on the same product (a missing suffix/letter) stays well above it.
const FUZZY_THRESHOLD = 0.82;

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
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
): InvoiceItem | null {
  if (!invoiceItems || invoiceItems.length === 0) return null;

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
  return best;
}
