import type { ReactNode } from 'react';

/**
 * ActionBar — sticky bottom action region. safe-bottom pads it above the
 * Android gesture pill so the primary CTA never sits under the nav bar.
 */
export function ActionBar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`safe-bottom sticky inset-x-0 bottom-0 z-30 border-t border-line bg-raised px-4 pt-3 ${className}`}
    >
      {children}
    </div>
  );
}
