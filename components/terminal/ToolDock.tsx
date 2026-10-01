'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

export type ToolTint = 'blue' | 'neutral' | 'red' | 'green' | 'amber';

export interface ToolChip {
  id: string;
  /** Material ligature name, or a custom node (e.g. <PalletIcon/>) */
  icon: string | ReactNode;
  label: string;
  tint: ToolTint;
  /** Icon color override (design: blue add #33b1f0, amber #fbbf5c) */
  iconColor?: string;
  locked?: boolean;
  onPress?: () => void;
  flip?: boolean;
  /**
   * Amber count pill on the tile's top-left corner (e.g. labels saved but not
   * printed yet). Hidden at 0. The lock badge keeps the top-right corner.
   */
  badge?: number;
}

const TINT_BG: Record<ToolTint, string> = {
  blue: 'rgba(19,164,236,.2)',
  neutral: '#243444',
  red: 'rgba(239,68,68,.18)',
  green: 'rgba(34,197,94,.18)',
  amber: 'rgba(245,158,11,.18)',
};

interface ToolDockProps {
  chips: ToolChip[];
  /** Called when a locked chip is tapped (show the lock toast) */
  onLockedPress: () => void;
}

// Design tool dock: horizontal scroll row, 60px columns of 44×44 r13 icon
// tiles + labels. Chip order follows the page direction (<html dir>): in
// Hebrew the first chip is at the right and the rest scroll in from the left,
// in English the first chip is at the left and the rest scroll in from the
// right. (It used to force dir=ltr + row-reverse, which kept the Hebrew order
// in English sessions too, so the hidden chips hung off the LEFT edge, where
// an English reader never looks.) The end edge fades out — the cue that more
// chips are there. The 20px fade = the 12px end padding + the 8px blank on
// each side of a tile in its 60px column, so once fully scrolled no tile is
// faded. Locked chips keep the design look but carry a small amber lock badge
// and route taps to the lock toast.
export function ToolDock({ chips, onLockedPress }: ToolDockProps) {
  return (
    <div
      className="flex items-start gap-[6px] overflow-x-auto overflow-y-hidden no-scrollbar px-3 pt-[2px] pb-[10px] [mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-20px),transparent)]"
      style={{ touchAction: 'pan-x', WebkitOverflowScrolling: 'touch' }}
    >
      {chips.map(chip => (
        <button
          key={chip.id}
          onClick={chip.locked ? onLockedPress : chip.onPress}
          className="flex-none flex flex-col items-center gap-1 w-[60px] text-ink-inverse py-[2px]"
        >
          <span
            className="relative w-11 h-11 rounded-[13px] flex items-center justify-center"
            style={{ background: TINT_BG[chip.tint] }}
          >
            {typeof chip.icon === 'string' ? (
              <MI name={chip.icon} size={22} flip={chip.flip} style={chip.iconColor ? { color: chip.iconColor } : undefined} />
            ) : (
              chip.icon
            )}
            {chip.locked && (
              <span className="absolute -top-1 -right-1 w-[17px] h-[17px] rounded-[5px] bg-[#1a2530] border border-[#3a4a57] flex items-center justify-center">
                <MI name="lock" size={11} style={{ color: '#f6b45a' }} />
              </span>
            )}
            {chip.badge && chip.badge > 0 ? (
              <span
                dir="ltr"
                className="absolute -top-1 -left-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#f59e0b] text-[#0b1117] text-[10px] font-black leading-none flex items-center justify-center"
              >
                {chip.badge > 99 ? '99+' : chip.badge}
              </span>
            ) : null}
          </span>
          <span className="text-[9.5px] font-bold whitespace-nowrap">{chip.label}</span>
        </button>
      ))}
    </div>
  );
}
