import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'brand' | 'neutral';

const toneClass: Record<Tone, string> = {
  ok: 'bg-ok-weak text-ok-weak-ink',
  warn: 'bg-warn-weak text-warn-weak-ink',
  danger: 'bg-danger-weak text-danger-weak-ink',
  info: 'bg-info-weak text-info-weak-ink',
  brand: 'bg-brand-weak text-brand-weak-ink',
  neutral: 'bg-sunken text-ink-muted',
};

/**
 * StatusBadge — a single rounded pill for OCR/scan status. Centralizes the
 * scattered bg-{color}-100 text-{color}-700 pills onto AA-safe tokens.
 */
export function StatusBadge({
  tone,
  children,
  icon: Icon,
  size = 'md',
  className = '',
}: {
  tone: Tone;
  children?: ReactNode;
  icon?: LucideIcon;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sz = size === 'sm' ? 'text-[11px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  const iconSz = size === 'sm' ? 12 : 14;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${sz} ${toneClass[tone]} ${className}`}
    >
      {Icon && <Icon size={iconSz} strokeWidth={2.5} className="shrink-0" />}
      {children}
    </span>
  );
}
