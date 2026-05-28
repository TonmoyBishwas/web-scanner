import type { ReactNode } from "react";

/**
 * SectionLabel — small Hebrew (or English) label above a group, with an
 * optional trailing chip.
 *
 * Minimal direction: no all-caps shouting, just a soft secondary-text label
 * with breathing room.
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
        "flex items-center justify-between mb-3 px-1",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="hebrew-label">{children}</span>
      {trailing ? <span className="hebrew-label">{trailing}</span> : null}
    </div>
  );
}
