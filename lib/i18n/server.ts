/**
 * Server-safe i18n helpers.
 *
 * Use these from server components, API routes, server-side helpers.
 * Client components should import from `@/lib/i18n` (which provides the
 * React context and hooks).
 *
 * Numbers, item names from OCR, supplier names, LPNs and barcodes
 * stay in source form. Only structural labels are translated.
 */

import { en, type TranslationKey } from './en';
import { he } from './he';
import type { Language } from '@/types';

export type { TranslationKey } from './en';

/** Substitutes `{name}` placeholders in a translation. */
function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  );
}

/**
 * Look up a key in the given language. Falls back to English for any
 * value other than 'Hebrew' — covers undefined, '', typos like 'he'.
 */
export function t(
  language: Language | string | undefined,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const dict = language === 'Hebrew' ? he : en;
  return format(dict[key], vars);
}

/** Whether the given language reads right-to-left. Used for `dir=` attrs. */
export function isRtl(language: Language | string | undefined): boolean {
  return language === 'Hebrew';
}
