/**
 * ProgressBar — calm rounded bar. Replaces the round ProgressRing.
 *
 * - Track: light surface (--surface-3).
 * - Fill: black by default (matches the primary accent). Green when done.
 * - Segments are auto-shown for small targets (≤ 30) and auto-hidden above.
 */

interface ProgressBarProps {
  current: number;
  target: number;
  tone?: "accent" | "success" | "warning";
  segmented?: boolean;
  className?: string;
}

const toneFill = {
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
} as const;

export function ProgressBar({
  current,
  target,
  tone = "accent",
  segmented,
  className,
}: ProgressBarProps) {
  const safeTarget = Math.max(1, target);
  const filled = Math.max(0, Math.min(current, safeTarget));
  const pct = (filled / safeTarget) * 100;
  const showSegments = segmented ?? safeTarget <= 30;
  const done = filled >= safeTarget;
  const fill = done ? toneFill.success : toneFill[tone];

  return (
    <div
      role="progressbar"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={safeTarget}
      className={[
        "relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={["h-full transition-[width] duration-200 rounded-full", fill].join(" ")}
        style={{ width: `${pct}%` }}
      />
      {showSegments && safeTarget > 1 ? (
        <div className="pointer-events-none absolute inset-0 flex">
          {Array.from({ length: safeTarget - 1 }, (_, i) => (
            <span
              key={i}
              style={{ width: `${100 / safeTarget}%` }}
              className="block border-r border-[var(--surface-0)] last:border-r-0"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
