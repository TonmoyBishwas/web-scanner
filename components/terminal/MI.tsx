'use client';

import type { CSSProperties } from 'react';

interface MIProps {
  /** Material Icons Round ligature name, e.g. "check_circle" */
  name: string;
  /** Font size in px (design uses 14–38) */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Mirror horizontally (design flips e.g. `send` for RTL) */
  flip?: boolean;
}

// Material Icons Round glyph. The `.mi` utility (globals.css) sets the icon
// font + ligature rendering; color inherits from the parent unless className
// overrides it.
export function MI({ name, size = 22, className = '', style, flip = false }: MIProps) {
  return (
    <span
      aria-hidden
      className={`mi ${className}`}
      style={{
        fontSize: size,
        ...(flip ? { transform: 'scaleX(-1)' } : null),
        ...style,
      }}
    >
      {name}
    </span>
  );
}

// The design's stacked-boxes pallet glyph (no Material equivalent).
export function PalletIcon({ size = 24, stroke = '#fff' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinejoin="round" aria-hidden>
      <rect x="7" y="3.5" width="10" height="6" rx="0.6" />
      <rect x="4.5" y="10" width="7" height="6" rx="0.6" />
      <rect x="12.5" y="10" width="7" height="6" rx="0.6" />
      <path d="M3 18.5h18M6 18.5v2.2M18 18.5v2.2" strokeLinecap="round" />
    </svg>
  );
}
