'use client';

import { LanguageContext } from '@/lib/i18n';
import type { Language } from '@/types';
import type { ReactNode } from 'react';

/**
 * Root wrapper each page mounts after it knows the session's language.
 *
 * - Provides the React context that `useT()` reads.
 * - Sets `dir="rtl"` on the wrapper div when language is Hebrew, so
 *   Tailwind logical utilities (ms-*, me-*, text-start, text-end) flip
 *   automatically and absolute-positioned elements respect bidi.
 *
 * Usage:
 *   const lang = session?.language ?? 'English';
 *   return (
 *     <LangDirRoot language={lang}>
 *       <PageContent />
 *     </LangDirRoot>
 *   );
 */
export function LangDirRoot({
  language,
  children,
  className,
}: {
  language: Language | string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const lang: Language = language === 'Hebrew' ? 'Hebrew' : 'English';
  const dir = lang === 'Hebrew' ? 'rtl' : 'ltr';
  return (
    <LanguageContext.Provider value={lang}>
      <div dir={dir} lang={lang === 'Hebrew' ? 'he' : 'en'} className={className}>
        {children}
      </div>
    </LanguageContext.Provider>
  );
}
