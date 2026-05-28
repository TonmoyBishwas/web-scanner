import type { HTMLAttributes, ReactNode } from "react";

/**
 * Card — white surface with a soft hairline border.
 *
 * Minimal-clean direction: thin borders + generous rounded corners.
 * No drop shadows by default (they add visual noise; the border does the job).
 *
 * `elevated` = surface-2 (the lighter grouping behind a card-of-cards or a
 * sheet body). `flush` removes padding (use when the card hosts a list and you
 * want ListRow to control inset).
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
        "border border-[var(--border-default)] rounded-2xl",
        flush ? "" : "p-5",
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
