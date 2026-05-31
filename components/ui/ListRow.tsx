import type { ReactNode } from 'react';

type Tone = 'default' | 'ok' | 'warn' | 'danger';

const toneClass: Record<Tone, string> = {
  default: 'bg-raised border-line',
  ok: 'bg-ok-weak border-ok/30',
  warn: 'bg-warn-weak border-warn/30',
  danger: 'bg-danger-weak border-danger/30',
};

/**
 * ListRow — one item in a scanned/issued list. Leading slot (thumbnail/icon),
 * title + optional subtitle, trailing slot (status/weight). Logical spacing
 * mirrors for RTL; trailing is pushed with ms-auto. tap-target keeps it
 * comfortably pressable when onClick is set.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  tone = 'default',
  className = '',
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  className?: string;
}) {
  const base = `flex items-center gap-3 rounded-xl border px-3 py-2.5 ${toneClass[tone]} ${className}`;
  const inner = (
    <>
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        {subtitle && (
          <div className="truncate text-xs text-ink-muted">{subtitle}</div>
        )}
      </div>
      {trailing && <div className="ms-auto shrink-0">{trailing}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`tap-target w-full text-start transition-colors hover:bg-hover ${base}`}
      >
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}
