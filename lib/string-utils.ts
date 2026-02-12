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
    return str
        .toLowerCase()
        .replace(/[^a-z0-9\u0590-\u05FF]/g, '');
}
