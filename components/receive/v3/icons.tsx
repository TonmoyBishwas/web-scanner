/**
 * Receive form v3: the prototype's Material Icons Round, mapped to
 * lucide-react (already a dependency). Stroke 2, `currentColor`.
 */
import type React from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  Minus,
  Plus,
  Search,
  Square,
  SquareCheck,
  X,
} from 'lucide-react';

const MAP = {
  remove: Minus,
  add: Plus,
  arrow_back: ArrowLeft,
  arrow_forward: ArrowRight,
  close: X,
  search: Search,
  check_box: SquareCheck,
  check_box_outline_blank: Square,
  description: FileText,
  inventory_2: Archive,
  expand_more: ChevronDown,
  calendar_month: CalendarDays,
  check: Check,
} as const;

export type V3IconName = keyof typeof MAP;

export function V3Icon({ name, size }: { name: V3IconName; size: number }) {
  const C = MAP[name];
  return <C size={size} strokeWidth={2} color="currentColor" aria-hidden="true" focusable="false" style={{ display: 'block', flex: 'none' }} />;
}

/** "Forward" in the reading direction: ← in Hebrew (RTL), → in English. */
export function ForwardIcon({ rtl, size }: { rtl: boolean; size: number }) {
  return <V3Icon name={rtl ? 'arrow_back' : 'arrow_forward'} size={size} />;
}

/** The × that closes a layer: 44×44, aria/title "סגירה" (receive.v3.close). */
export function CloseButton({
  label,
  onClick,
  size = 24,
  color,
  style,
}: {
  label: string;
  onClick: () => void;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 44,
        height: 44,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        padding: 0,
        color: color ?? 'var(--v3-ink)',
        zIndex: 2,
        ...style,
      }}
    >
      <V3Icon name="close" size={size} />
    </button>
  );
}
