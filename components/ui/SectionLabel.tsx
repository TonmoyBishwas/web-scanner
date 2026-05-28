import type { ReactNode } from "react";

/**
 * SectionLabel — all-caps micro label. Used as the header above a list
 * (e.g. "PRODUCTS", "SCANNED", "ISSUED"). Reads like an equipment label.
 *
 * Pass `trailing` for a counter chip aligned to the opposite side.
 */

interface SectionLabelProps {
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

export function SectionLabel({ children, trailing, className }: SectionLabelProps) {
  return (
    <div
      className={[
        "flex items-center justify-between",
        "border-b border-[var(--border-default)] pb-2 mb-3",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="micro-label">{children}</span>
      {trailing ? <span className="micro-label">{trailing}</span> : null}
    </div>
  );
}
