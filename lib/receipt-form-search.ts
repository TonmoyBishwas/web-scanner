/**
 * Item search for the delivery-note receiving form (/receive/[id]).
 *
 * Pure logic only — a VIEW filter. It never changes what is validated,
 * counted ("N lines still need input") or submitted: every line of the note
 * stays in the draft and in validateAnswers whether it is on screen or not.
 *
 * Matching, in order:
 *   1. strict: every query word is a substring of the line's name (he/en)
 *      or supplier code, after searchKey() folding; a whole-number word also
 *      matches the line number (#4).
 *   2. typo fallback (only when strict finds nothing anywhere): every query
 *      word of ≥ 3 letters is within one edit of the start of some word of
 *      the line (OCR'd names drift: פרינר / פריניר).
 */
import { levenshtein } from './invoice-match';

export interface SearchableLine {
  index: number;
  code: string;
  name_he: string;
  name_en: string;
}

/** Show the search box from this many lines on (median note = 5 lines). */
export const SEARCH_MIN_LINES = 6;

const FINALS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/**
 * Fold a string for search: lower-case Latin; drop niqqud/cantillation
 * (U+0591–U+05C7), geresh/gershayim and every quote, space and symbol;
 * final letters → regular (ך→כ ם→מ ן→נ ף→פ ץ→צ). Keeps a–z, 0–9, א–ת.
 *   'ק"ג בד"ץ'      → 'קגבדצ'
 *   'פקדון'          → 'פקדונ'  (so 'פקדו' typed mid-word still matches)
 */
export function searchKey(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^a-z0-9א-ת]/g, '');
}

/** The query's words, folded; empty words dropped. */
export function queryWords(query: string): string[] {
  return query
    .split(/[\s,;/|\-–—]+/)
    .map(searchKey)
    .filter(Boolean);
}

function lineFields(line: SearchableLine): string[] {
  return [searchKey(line.name_he), searchKey(line.name_en), searchKey(line.code)].filter(Boolean);
}

function strictHit(line: SearchableLine, words: string[]): boolean {
  const fields = lineFields(line);
  return words.every(
    (w) => fields.some((f) => f.includes(w)) || (/^\d{1,3}$/.test(w) && Number(w) === line.index),
  );
}

/** The line's words (split BEFORE folding, so word starts survive). */
function lineWords(line: SearchableLine): string[] {
  return `${line.name_he} ${line.name_en}`.split(/[\s,;/|\-–—]+/).map(searchKey).filter(Boolean);
}

function fuzzyHit(line: SearchableLine, words: string[]): boolean {
  const lw = lineWords(line);
  return words.every((w) => {
    if (w.length < 3 || /^\d+$/.test(w)) return lineFields(line).some((f) => f.includes(w));
    return lw.some(
      (x) =>
        levenshtein(w, x.slice(0, w.length)) <= 1 ||
        levenshtein(w, x.slice(0, w.length + 1)) <= 1 ||
        levenshtein(w, x) <= 1,
    );
  });
}

export interface LineSearchResult<T> {
  /** Lines to show, in note order. Every line when the query is empty. */
  lines: T[];
  /** True when the query is non-empty (the view is filtered). */
  active: boolean;
  /** True when nothing matched strictly and these are typo-tolerant matches. */
  fuzzy: boolean;
}

export function searchLines<T extends SearchableLine>(lines: T[], query: string): LineSearchResult<T> {
  const words = queryWords(query);
  if (!words.length) return { lines, active: false, fuzzy: false };
  const strict = lines.filter((l) => strictHit(l, words));
  if (strict.length) return { lines: strict, active: true, fuzzy: false };
  const loose = lines.filter((l) => fuzzyHit(l, words));
  return { lines: loose, active: true, fuzzy: loose.length > 0 };
}

/**
 * Where "next line to fill" goes while a search is on: the first incomplete
 * line among the search results; else (all results are done) the first
 * incomplete line of the whole note — the caller then clears the search so
 * that line is on screen. null = no incomplete line at all.
 */
export function nextIncompleteLine(
  noteOrder: number[],
  incomplete: (index: number) => boolean,
  shown: ReadonlySet<number> | null,
): { index: number; clearSearch: boolean } | null {
  if (shown) {
    const inResults = noteOrder.find((i) => shown.has(i) && incomplete(i));
    if (inResults !== undefined) return { index: inResults, clearSearch: false };
  }
  const any = noteOrder.find(incomplete);
  if (any === undefined) return null;
  return { index: any, clearSearch: !!shown && !shown.has(any) };
}
