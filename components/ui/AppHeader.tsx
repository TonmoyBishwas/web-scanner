import type { ReactNode } from 'react';

/**
 * AppHeader — consistent top bar across worker screens. Title/subtitle on the
 * leading side, action slot (settings, done) on the trailing side. Uses
 * logical padding so it mirrors correctly in Hebrew RTL, and safe-top so it
 * clears the status bar on notched devices.
 */
export function AppHeader({
  title,
  subtitle,
  right,
  left,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  left?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`safe-top sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-raised px-4 py-3 ${className}`}
    >
      {left}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold leading-tight text-ink">
          {title}
        </h1>
        {subtitle && (
          <p className="truncate text-sm text-ink-muted">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </header>
  );
}
