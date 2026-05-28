import type { HTMLAttributes, ReactNode } from "react";

/**
 * Card — bordered, surface-1 container. Replaces the prior `bg-gray-800
 * rounded-2xl shadow-lg` pattern. Separation is by border, not shadow, so it
 * doesn't get washed out under warehouse lighting.
 *
 * Use `elevated` for modals / bottom-sheet bodies (surface-2).
 * Use `flush` (no padding) when the card hosts a list (let ListRow control inset).
 */

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
  flush?: boolean;
  children: ReactNode;
}

export function Card({ elevated, flush, children, className, ...rest }: CardProps) {
  return (
    <div
      className={[
        elevated ? "bg-[var(--surface-2)]" : "bg-[var(--surface-1)]",
        "border border-[var(--border-default)] rounded-xl",
        flush ? "" : "p-4",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}
