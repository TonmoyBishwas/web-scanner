import type { ReactNode, MouseEventHandler } from "react";

/**
 * ListRow — generic row inside a list (scanned boxes, issued boxes, items).
 *
 * Slots (RTL-aware via Tailwind logical properties):
 *   [leading]   [label / sublabel]                [trailing]
 *
 * Minimal direction: hairline divider between rows, no full borders, more
 * breathing room than the prior industrial look.
 */

interface ListRowProps {
  leading?: ReactNode;
  label: ReactNode;
  sublabel?: ReactNode;
  trailing?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  borderless?: boolean;
  /** Soft tonal background — for needs-review / duplicate-rejected rows. */
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}

const toneClasses = {
  default: "",
  success: "bg-[var(--success-soft)]",
  warning: "bg-[var(--warning-soft)]",
  danger: "bg-[var(--danger-soft)]",
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
        "flex items-center gap-3 px-5 min-h-[64px] py-2.5",
        borderless ? "" : "border-b border-[var(--border-default)] last:border-b-0",
        interactive
          ? "cursor-pointer active:bg-[var(--surface-2)] transition-colors"
          : "",
        toneClasses[tone],
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
