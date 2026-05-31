import type { ElementType, ReactNode } from 'react';

type Tone = 'default' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';

const toneClass: Record<Tone, string> = {
  default: 'bg-raised border-line',
  ok: 'bg-ok-weak border-ok/30',
  warn: 'bg-warn-weak border-warn/30',
  danger: 'bg-danger-weak border-danger/30',
  info: 'bg-info-weak border-info/30',
  brand: 'bg-brand-weak border-brand/30',
};

/**
 * Card — the one surface primitive. Default is a white raised panel with a
 * hairline border; `tone` tints it for alert/status contexts. Presentational
 * only; pass already-translated content.
 */
export function Card({
  children,
  className = '',
  tone = 'default',
  as,
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
  as?: ElementType;
}) {
  const Comp = as ?? 'div';
  return (
    <Comp className={`rounded-2xl border p-4 ${toneClass[tone]} ${className}`}>
      {children}
    </Comp>
  );
}
