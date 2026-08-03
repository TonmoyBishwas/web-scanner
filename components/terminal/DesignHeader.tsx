'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

interface DesignHeaderProps {
  title: string;
  subtitle?: string;
  onMenu?: () => void;
  onBack?: () => void;
  /** Optional trailing slot (replaces the decorative back arrow) */
  right?: ReactNode;
}

// Design header: 56px, #0a0f14, hairline #101821 bottom border.
// RTL start = hamburger, centered 2-line title, RTL end = back arrow.
export function DesignHeader({ title, subtitle, onMenu, onBack, right }: DesignHeaderProps) {
  return (
    <div className="h-14 flex-none bg-header flex items-center justify-between px-2 border-b border-[#101821] relative z-30 safe-top box-content">
      {onMenu ? (
        <button onClick={onMenu} className="p-2 flex text-ink-inverse" aria-label="menu">
          <MI name="menu" size={23} />
        </button>
      ) : (
        <span className="w-10" />
      )}
      <div className="flex flex-col items-center gap-[1px] min-w-0 px-1">
        <h1 className="text-[13px] font-extrabold text-ink-inverse m-0 whitespace-nowrap overflow-hidden text-ellipsis max-w-[220px]">
          {title}
        </h1>
        {subtitle && (
          <span className="text-[10.5px] font-semibold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis max-w-[240px]">
            {subtitle}
          </span>
        )}
      </div>
      {right ?? (
        onBack ? (
          <button onClick={onBack} className="p-2 flex text-[#e8eef2]" aria-label="back">
            <MI name="arrow_back_ios" size={20} />
          </button>
        ) : (
          <span className="w-10" />
        )
      )}
    </div>
  );
}
