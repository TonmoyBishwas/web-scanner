'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

interface ScreenOverlayProps {
  title: string;
  onBack: () => void;
  children: ReactNode;
}

// Design full-screen nav destination: z-90 overlay on canvas with a 56px
// sub-header (back arrow at the RTL start, then the title).
export function ScreenOverlay({ title, onBack, children }: ScreenOverlayProps) {
  return (
    <div className="fixed inset-0 z-[90] bg-canvas flex flex-col">
      <div className="h-14 flex-none flex items-center gap-2 px-2 border-b border-[#101821] bg-header safe-top box-content">
        <button onClick={onBack} className="p-2 flex text-[#e8eef2]" aria-label="back">
          <MI name="arrow_forward_ios" size={22} />
        </button>
        <h1 className="flex-1 text-[15px] font-extrabold text-ink-inverse m-0">{title}</h1>
      </div>
      <div className="flex-1 min-h-0 flex flex-col relative">{children}</div>
    </div>
  );
}
