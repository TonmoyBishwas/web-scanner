/**
 * Normalizes a string for fuzzy matching.
 * Removes all non-word characters (punctuation, spaces, symbols) and converts to lowercase.
 * Preserves Hebrew characters (\u0590-\u05FF).
 * 
 * Example: "Meatballs - Red Base" -> "meatballsredbase"
 * Example: "קציצות ברוטב. אדום" -> "קציצותברוטבאדום"
 */
export function normalizeString(str: string | null | undefined): string {
    if (!str) return '';
    // Remove ALL characters except English (a-z, 0-9) and Hebrew (\u0590-\u05FF)
    // This removes spaces, dots, hyphens, quotes, underscores, etc.
    // Niqqud goes too, so a vowelled OCR read equals its plain spelling (PB2).
    return stripNiqqud(str)
        .toLowerCase()
        .replace(/[^a-z0-9\u0590-\u05FF]/g, '');
}

/**
 * Hebrew vowel points and cantillation marks (niqqud) — combining marks, not
 * letters. Hebrew punctuation in the same block (maqaf ־, paseq ׀, sof pasuq ׃,
 * nun hafukha ׆) and geresh / gershayim are kept: they separate words.
 */
const NIQQUD = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;

/**
 * Drop niqqud: "בְּשַׂר" → "בשר". Box-sticker OCR sometimes returns a vowelled
 * name (e2e harness run r2610241337-ag6d, PB2); without this the matcher's
 * word split broke every word into fragments and the carton matched no line.
 */
export function stripNiqqud(str: string): string {
    return str.replace(NIQQUD, '');
}
