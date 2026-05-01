/**
 * i18n entry point.
 *
 * Use `useT()` inside React client components — it reads the current
 * language from React context (set by each page's mount based on the
 * session's `language` field).
 *
 * Use `t(language, key, vars)` from server code (API routes,
 * server-side helpers) where there's no React context.
 *
 * Numbers, item names from OCR, supplier names, LPNs and barcodes
 * stay in source form. Only structural labels are translated.
 */
'use client';

import { createContext, useContext, useEffect, useMemo } from 'react';
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

/** React context that holds the current language for a page subtree. */
export const LanguageContext = createContext<Language>('English');

/**
 * Hook returning a translator bound to the current language context.
 * Usage:
 *   const tr = useT();
 *   <button>{tr('common.confirm')}</button>
 */
export function useT() {
  const lang = useContext(LanguageContext);
  return useMemo(
    () =>
      (key: TranslationKey, vars?: Record<string, string | number>) =>
        t(lang, key, vars),
    [lang],
  );
}

/** Whether the given language reads right-to-left. Used for `dir=` attrs. */
export function isRtl(language: Language | string | undefined): boolean {
  return language === 'Hebrew';
}

/**
 * Set `<html dir="rtl|ltr">` and `<html lang="he|en">` based on the
 * language. Tailwind logical utilities (ms-*, me-*, text-start,
 * text-end) flip automatically when `dir` is rtl, so existing layouts
 * mostly work without per-component edits.
 *
 * Call once per page after the session loads. Idempotent and cleans
 * itself up to "ltr"/"en" when the component unmounts so navigating
 * to another (non-i18n) page doesn't leak RTL styling.
 */
export function useLangDir(language: Language | string | undefined) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const isHebrew = language === 'Hebrew';
    const prevDir = html.dir;
    const prevLang = html.lang;
    html.dir = isHebrew ? 'rtl' : 'ltr';
    html.lang = isHebrew ? 'he' : 'en';
    return () => {
      html.dir = prevDir;
      html.lang = prevLang;
    };
  }, [language]);
}
