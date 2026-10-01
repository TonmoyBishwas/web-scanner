'use client';

import { useContext, type ReactNode } from 'react';
import { MI } from './MI';
import { useBackClose } from '@/lib/use-back-close';
import { LanguageContext, useT } from '@/lib/i18n';

interface ScreenOverlayProps {
  title: string;
  onBack: () => void;
  children: ReactNode;
}

// Design full-screen nav destination: z-90 overlay on canvas with a 56px
// sub-header (back arrow at the start, then the title).
export function ScreenOverlay({ title, onBack, children }: ScreenOverlayProps) {
  const tr = useT();
  const isHe = useContext(LanguageContext) === 'Hebrew';
  // This component only renders while its screen is open, so it always owns a
  // history entry — the device Back button closes the screen rather than
  // unloading the scanning session.
  useBackClose(true, onBack);

  return (
    <div className="fixed inset-0 z-[90] bg-canvas flex flex-col">
      <div className="h-14 flex-none flex items-center gap-2 px-2 border-b border-[#101821] bg-header safe-top box-content">
        <button onClick={onBack} className="tap-target flex-none flex items-center justify-center text-[#e8eef2]" aria-label={tr('common.back')}>
          {/* Points back in both directions: right in Hebrew, left in English. */}
          <MI name="arrow_forward_ios" size={22} flip={!isHe} />
        </button>
        <h1 className="flex-1 text-[15px] font-extrabold text-ink-inverse m-0">{title}</h1>
      </div>
      <div className="flex-1 min-h-0 flex flex-col relative">{children}</div>
    </div>
  );
}
