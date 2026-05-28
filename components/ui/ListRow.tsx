import type { ReactNode, MouseEventHandler } from "react";

/**
 * ListRow — generic row inside a list (scanned boxes, issued boxes, items grid).
 *
 * Slots:
 *   [leading]   [label/sublabel]                [trailing]
 *
 * - `onClick` makes the row interactive (hover/press feedback, role=button).
 * - Use the `borderless` prop on the LAST row of a card to skip the divider.
 */

interface ListRowProps {
  leading?: ReactNode;
  label: ReactNode;
  sublabel?: ReactNode;
  trailing?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  borderless?: boolean;
  /**
   * `tone` lets a row signal state without a separate badge — e.g. a soft red tint
   * on a duplicate-rejected entry. Default = no tint.
   */
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}

const toneRingClasses = {
  default: "",
  success: "ring-1 ring-inset ring-[var(--success)]/30 bg-[var(--success-soft)]",
  warning: "ring-1 ring-inset ring-[var(--warning)]/30 bg-[var(--warning-soft)]",
  danger: "ring-1 ring-inset ring-[var(--danger)]/30 bg-[var(--danger-soft)]",
} as const;

export function ListRow({
  leading,
  label,
  sublabel,
  trailing,
  onClick,
  borderless,
  tone = "default",
  className,
}: ListRowProps) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                (e.currentTarget as HTMLDivElement).click();
              }
            }
          : undefined
      }
      className={[
        "flex items-center gap-3 px-4 min-h-[56px] py-2",
        borderless ? "" : "border-b border-[var(--border-default)] last:border-b-0",
        interactive
          ? "cursor-pointer active:bg-[var(--surface-3)] transition-colors"
          : "",
        toneRingClasses[tone],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="text-[16px] leading-[20px] text-[var(--text-primary)] truncate">
          {label}
        </div>
        {sublabel ? (
          <div className="text-[13px] leading-[18px] text-[var(--text-secondary)] truncate mt-0.5">
            {sublabel}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
