import type { ReactNode } from "react";

/**
 * Counter — the signature `17 / 42` mono number display. Hero of every screen.
 *
 * `size`:
 *  - `hero`    = 56 px. The big page-level counter (boxes scanned vs target).
 *  - `display` = 32 px. Secondary counters (pallet 2 / 4 above the hero).
 *  - `inline`  = 18 px. Per-row counters.
 *
 * `tone`:
 *  - `default` = black current, gray target.
 *  - `success` = green when 100 % done.
 *  - `warning` = amber if needs-review state is the dominant signal.
 *
 * The number block is forced `dir="ltr"` even inside an RTL page — numbers
 * read left-to-right in Hebrew too.
 */

interface CounterProps {
  current: number | string;
  target?: number | string;
  size?: "hero" | "display" | "inline";
  /** Optional Hebrew label (small) — e.g. ארגזים, משטח. */
  label?: ReactNode;
  /** Lucide icon rendered before the label. */
  icon?: ReactNode;
  tone?: "default" | "success" | "warning";
  className?: string;
}

const sizeClasses = {
  hero: "text-[56px] leading-[60px]",
  display: "text-[32px] leading-[36px]",
  inline: "text-[18px] leading-[22px]",
} as const;

const toneClasses = {
  default: "text-[var(--text-primary)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
} as const;

export function Counter({
  current,
  target,
  size = "hero",
  label,
  icon,
  tone = "default",
  className,
}: CounterProps) {
  return (
    <div
      className={[
        "flex flex-col items-center gap-2",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {(icon || label) && (
        <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
          {icon ? <span className="shrink-0">{icon}</span> : null}
          {label ? <span className="hebrew-label">{label}</span> : null}
        </div>
      )}
      <span
        dir="ltr"
        className={[
          "counter-display tabular-nums",
          sizeClasses[size],
          toneClasses[tone],
        ].join(" ")}
      >
        <span>{current}</span>
        {target !== undefined && target !== null ? (
          <>
            <span className="text-[var(--text-tertiary)] mx-2 font-thin">/</span>
            <span className="text-[var(--text-tertiary)]">{target}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
