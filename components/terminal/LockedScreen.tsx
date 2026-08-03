'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { useT } from '@/lib/i18n';

interface LockedScreenProps {
  title: string;
  onBack: () => void;
  /** Designed sample content — rendered dimmed and non-interactive */
  children?: ReactNode;
  /** Icon for the empty/stub variant (no children) */
  stubIcon?: string;
}

// Locked feature surface: the designed chrome renders, sample content is
// dimmed (opacity-40, pointer-events-none) and a centered lock chip states
// "נעול · לא זמין עדיין". With no children → design's "under construction"
// stub layout with a lock line.
export function LockedScreen({ title, onBack, children, stubIcon = 'settings' }: LockedScreenProps) {
  const tr = useT();

  return (
    <ScreenOverlay title={title} onBack={onBack}>
      {children ? (
        <>
          <div className="flex-1 min-h-0 overflow-hidden opacity-40 pointer-events-none select-none" aria-hidden>
            {children}
          </div>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-2 bg-[#1a2530] border border-[#3a4a57] rounded-[12px] px-4 py-3 shadow-[0_14px_34px_rgba(0,0,0,.6)]">
              <MI name="lock" size={18} style={{ color: '#f6b45a' }} />
              <span className="text-[13px] font-extrabold text-ink">{tr('terminal.lockedToast')}</span>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="w-[74px] h-[74px] rounded-[20px] bg-brand-weak flex items-center justify-center">
            <MI name={stubIcon} size={34} className="text-brand" />
          </div>
          <div className="text-[16px] font-black text-ink-inverse">{title}</div>
          <div className="text-[12px] font-semibold text-ink-muted">{tr('terminal.underConstruction')}</div>
          <div className="flex items-center gap-2 bg-[#1a2530] border border-[#3a4a57] rounded-[12px] px-4 py-2 mt-2">
            <MI name="lock" size={16} style={{ color: '#f6b45a' }} />
            <span className="text-[12px] font-extrabold text-ink">{tr('terminal.lockedToast')}</span>
          </div>
        </div>
      )}
    </ScreenOverlay>
  );
}
