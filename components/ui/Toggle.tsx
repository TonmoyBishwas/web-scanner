import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Toggle — visual on/off switch. State lives in the caller (e.g. settings
 * store); this is purely presentational. Optional leading icon + label render
 * a full settings row; omit them to use the bare switch.
 */
export function Toggle({
  enabled,
  onChange,
  label,
  icon: Icon,
  className = '',
}: {
  enabled: boolean;
  onChange?: () => void;
  label?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const sw = (
    <span
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        enabled ? 'bg-brand' : 'bg-line-strong'
      }`}
    >
      <span
        className={`absolute h-5 w-5 rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </span>
  );

  if (label === undefined && Icon === undefined) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={onChange}
        className={className}
      >
        {sw}
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-hover ${className}`}
    >
      {Icon && <Icon size={20} className="shrink-0 text-ink-muted" />}
      {label && <span className="flex-1 text-sm font-semibold text-ink">{label}</span>}
      {sw}
    </button>
  );
}
