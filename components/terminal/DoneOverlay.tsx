'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';

export interface DoneStat {
  value: ReactNode;
  label: string;
  /** Slightly wider tile (design uses flex 1.3 for weight) */
  wide?: boolean;
}

interface DoneOverlayProps {
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  stats?: DoneStat[];
  /** Buttons / SwipeConfirm slot under the stats */
  children?: ReactNode;
}

// Design done overlay: z-70 blurred scrim, centered #0d171d card on the green
// hairline, donePop icon circle, 19px title, 3 stat tiles (#0c141a).
export function DoneOverlay({
  icon = 'check_circle', iconColor = '#4ade80', iconBg = 'rgba(34,197,94,.14)',
  title, subtitle, stats, children,
}: DoneOverlayProps) {
  return (
    <div className="absolute inset-0 z-[70] bg-[rgba(5,8,10,.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
      <div className="w-full max-w-[330px] bg-overlay-card border border-[#1e3a2e] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,.72)] animate-doneRise">
        <div className="flex justify-center mb-[13px]">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center animate-donePop"
            style={{ background: iconBg }}
          >
            <MI name={icon} size={37} style={{ color: iconColor }} />
          </div>
        </div>
        <div className="text-center text-[19px] font-black text-ink-inverse">{title}</div>
        {subtitle && (
          <div className="text-center text-[12px] font-semibold text-ink-muted mt-1">{subtitle}</div>
        )}
        {stats && stats.length > 0 && (
          <div className="flex gap-2 mt-4">
            {stats.map((s, i) => (
              <div
                key={i}
                className="bg-sunken border border-line rounded-[11px] px-[6px] py-[10px] text-center"
                style={{ flex: s.wide ? 1.3 : 1 }}
              >
                <div className="text-[16px] font-black text-ink-inverse">{s.value}</div>
                <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
