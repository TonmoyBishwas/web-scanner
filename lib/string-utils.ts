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
    // Remove all characters except word chars (a-z, 0-9, _) and Hebrew chars
    return str
        .toLowerCase()
        .replace(/[^\w\u0590-\u05FF]/g, '');
}
