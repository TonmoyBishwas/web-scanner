import type { ReactNode } from "react";

/**
 * Counter — the signature `17 / 42` mono number display used at the top of
 * scan / issue / pallet-verify. Wide tabular numerals so digits don't jitter.
 *
 * `size`:
 * - `display` = big hero counter (32 px). Use one per screen.
 * - `inline`  = list-row counter (18 px). For per-item counts.
 */

interface CounterProps {
  current: number | string;
  target?: number | string;
  size?: "display" | "inline";
  label?: ReactNode;
  accent?: "default" | "warning" | "success";
  className?: string;
}

const sizeClasses = {
  display: "text-[32px] leading-[38px]",
  inline: "text-[18px] leading-[24px]",
} as const;

const accentClasses = {
  default: "text-[var(--text-primary)]",
  warning: "text-[var(--warning)]",
  success: "text-[var(--success)]",
} as const;

export function Counter({
  current,
  target,
  size = "display",
  label,
  accent = "default",
  className,
}: CounterProps) {
  return (
    <div className={["flex flex-col gap-1", className ?? ""].filter(Boolean).join(" ")}>
      {label ? <span className="micro-label">{label}</span> : null}
      <span
        dir="ltr"
        className={[
          "counter-display tracking-tight",
          sizeClasses[size],
          accentClasses[accent],
        ].join(" ")}
      >
        <span>{current}</span>
        {target !== undefined && target !== null ? (
          <>
            <span className="text-[var(--text-tertiary)] mx-1.5">/</span>
            <span className="text-[var(--text-secondary)]">{target}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
