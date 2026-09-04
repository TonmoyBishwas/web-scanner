'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

interface DesignHeaderProps {
  title: string;
  subtitle?: string;
  onMenu?: () => void;
  onBack?: () => void;
  /** Optional leading slot, rendered just after the hamburger */
  leading?: ReactNode;
  /** Optional trailing slot (replaces the decorative back arrow) */
  right?: ReactNode;
}

// Design header: 56px, #0a0f14, hairline #101821 bottom border.
// RTL start = hamburger, centered 2-line title, RTL end = back arrow.
export function DesignHeader({ title, subtitle, onMenu, onBack, leading, right }: DesignHeaderProps) {
  return (
    <div className="h-14 flex-none bg-header flex items-center justify-between px-2 border-b border-[#101821] relative z-30 safe-top box-content">
      {/* Leading group: hamburger + an optional caller slot. Grouping them
          keeps `justify-between` centring the title on the real middle
          instead of shoving it off-axis once a slot is filled. */}
      <div className="flex-none flex items-center">
        {onMenu ? (
          <button onClick={onMenu} className="tap-target flex-none flex items-center justify-center text-ink-inverse" aria-label="menu">
            <MI name="menu" size={23} />
          </button>
        ) : (
          <span className="flex-none w-12" />
        )}
        {leading}
      </div>
      {/* Fluid centre column. It used to carry hard max-w-[220px]/[240px] caps,
          which truncated the pallet/document line early on wide phones and did
          nothing to help narrow ones — `min-w-0` plus ellipsis is what actually
          makes it adapt. */}
      <div className="flex-1 min-w-0 flex flex-col items-center gap-[1px] px-1">
        <h1 className="w-full text-center text-[13px] font-extrabold text-ink-inverse m-0 whitespace-nowrap overflow-hidden text-ellipsis">
          {title}
        </h1>
        {subtitle && (
          <span className="w-full text-center text-[10.5px] font-semibold text-ink-inverse whitespace-nowrap overflow-hidden text-ellipsis">
            {subtitle}
          </span>
        )}
      </div>
      {right ?? (
        onBack ? (
          <button onClick={onBack} className="tap-target flex-none flex items-center justify-center text-[#e8eef2]" aria-label="back">
            <MI name="arrow_back_ios" size={20} />
          </button>
        ) : (
          <span className="flex-none w-12" />
        )
      )}
    </div>
  );
}
