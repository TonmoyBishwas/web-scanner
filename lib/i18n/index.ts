/**
 * i18n entry point — client-side hooks + context.
 *
 * Use `useT()` inside React client components — it reads the current
 * language from React context (set by each page's mount based on the
 * session's `language` field).
 *
 * For server components, API routes, and server-side helpers, import
 * `t()` and `isRtl()` from `@/lib/i18n/server` instead — that module
 * has no React/client dependencies.
 */
'use client';

import { createContext, useContext, useEffect, useMemo } from 'react';
import { t, isRtl, type TranslationKey } from './server';
import type { Language } from '@/types';

export { t, isRtl };
export type { TranslationKey };

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
